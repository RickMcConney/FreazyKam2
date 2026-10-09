// The controller's SD card, filling the sidebar while the Machine tab is open (the
// draw tools have nothing to do there, and a card's file list can be long): the
// files, upload, delete, and Load — which reads a file off the card, draws its
// toolpath on the go-to map and makes it the job. The job box is pinned to the
// bottom, outside the scrolling list, so Run / Pause / Stop are always in reach.
//
// Above the card's files sits the CURRENT DESIGN: the map shows either it or the
// loaded job, whichever was clicked last. Clicking a file always re-reads it from
// the card, so what is shown is what is on the card. Send to card posts the design
// out and loads it as the job.
// Run runs only the job the map is SHOWING — what you see is what you cut.

import { useRef, useState } from 'react'
import { RefreshCw, Upload, Trash2, Folder, FileText, CornerLeftUp, Play, Pause, Square, X, HardDrive, DraftingCompass, Send } from 'lucide-react'
import { ICON } from '../theme'
import { useMachineStore } from '../machine/machineStore'
import { sdJoin, sdParent } from '../machine/fluidnc/sdFiles'
import { holdComplete } from '../machine/fluidnc/status'
import { useProjectStore } from '../store/projectStore'
import { useToolpathStore } from '../store/toolpathStore'

const iconBtn = 'p-1 rounded text-gray-600 dark:text-neutral-400 hover:bg-gray-300 dark:hover:bg-neutral-700 hover:text-gray-800 dark:hover:text-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent'
const btnCls = 'px-3 py-1 rounded text-sm border border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-300 dark:hover:bg-neutral-700 disabled:opacity-40'

export default function SdCardPanel() {
  const m = useMachineStore()
  const fileRef = useRef<HTMLInputElement>(null)
  // Delete is two clicks on the same row: the first arms it, the second deletes.
  const [armed, setArmed] = useState<string | null>(null)

  const connected = m.link === 'connected'
  const busy = m.sdBusy !== null
  const running = connected && m.position.sd !== null
  const listing = m.sdListing
  const isJob = (name: string) => m.job?.dir === m.sdPath && m.job.name === name
  const showingDesign = m.mapSource === 'design' || !m.job
  const projectName = useProjectStore((s) => s.name)
  const hasToolpaths = useToolpathStore((s) => s.operations.some((o) => o.visible && o.status === 'done' && o.segments.length > 0))
  // A click ALWAYS reads the file off the card. Re-showing the loaded copy instead
  // was instant but could be stale: after Send to card or an upload under the same
  // name it kept showing the old program, and only loading another file first
  // got the new one.
  const pick = (name: string) => void m.sdLoad(name)

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
        <HardDrive size={ICON.sm} className="text-gray-600 dark:text-neutral-400" />
        <span className="flex-1 text-sm font-semibold text-gray-700 dark:text-neutral-300">SD card</span>
        {/* No card traffic while a job runs: the controller is reading the job off that
            same card, and a transfer competing for the ESP32 is what stalls its link. */}
        {/* Labelled, not a bare icon: it is the way in for a program from any other CAM,
            and as an arrow beside Refresh it went unnoticed. */}
        <button className={`${iconBtn} flex items-center gap-1`}
          title={running ? 'Not while a job is running' : `Upload a G-code file from this computer to the card (${m.sdPath})`}
          disabled={!connected || busy || running} onClick={() => fileRef.current?.click()}>
          <Upload size={ICON.sm} /> <span>Upload file</span>
        </button>
        <button className={iconBtn} title="Refresh" disabled={!connected || busy} onClick={() => void m.sdRefresh()}>
          <RefreshCw size={ICON.sm} className={busy ? 'animate-spin' : ''} />
        </button>
        <input ref={fileRef} type="file" className="hidden" accept=".nc,.gcode,.gc,.ngc,.tap,.txt"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void m.sdUpload(f)
          }} />
      </div>

      <div className={`group mx-2 mt-2 flex items-center gap-1.5 px-2 py-1.5 rounded border text-xs flex-shrink-0 ${showingDesign
        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
        : 'border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900'}`}>
        <DraftingCompass size={ICON.sm} className="flex-shrink-0 text-blue-600 dark:text-sky-400" />
        <button className="flex-1 min-w-0 text-left truncate hover:underline text-gray-800 dark:text-neutral-200"
          onClick={m.showDesign} title="Show the design open in FreazyKam on the map">
          <span className="font-semibold">Current design</span>
          {projectName !== 'Untitled Project' && <span className="text-gray-500 dark:text-neutral-400"> — {projectName}</span>}
        </button>
        <button className={`${iconBtn} flex items-center gap-1`} disabled={!connected || busy || !hasToolpaths || running}
          onClick={() => void m.sendDesignToCard()}
          title={hasToolpaths ? `Write the design's G-code to the card (${m.sdPath}) and load it as the job` : 'Generate toolpaths first'}>
          <Send size={ICON.sm} /> <span>Send to card</span>
        </button>
      </div>

      <div className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 dark:text-neutral-400 flex-shrink-0">
        <button className={iconBtn} title="Up one folder" disabled={!connected || busy || m.sdPath === '/'}
          onClick={() => void m.sdRefresh(sdParent(m.sdPath))}>
          <CornerLeftUp size={ICON.sm} />
        </button>
        <span className="flex-1 truncate font-mono">{m.sdPath}</span>
        {listing?.used && listing.total && <span className="tabular-nums">{listing.used} / {listing.total}</span>}
      </div>

      <div className={`flex-1 min-h-0 overflow-y-auto mx-2 rounded border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 ${connected ? '' : 'opacity-40'}`}>
        {!listing || listing.files.length === 0
          ? <p className="px-2 py-1.5 text-xs text-gray-500 dark:text-neutral-500">{!connected ? 'Connect on the Machine tab to see the card' : listing ? 'No files' : '—'}</p>
          : listing.files.map((f) => (
            <div key={f.name}
              className={`group flex items-center gap-1.5 px-2 py-1 text-xs border-b last:border-b-0 border-gray-200 dark:border-neutral-800 ${isJob(f.name)
                ? showingDesign ? 'bg-gray-100 dark:bg-neutral-800' : 'bg-blue-50 dark:bg-blue-950'
                : ''}`}>
              {f.isDir
                ? <Folder size={ICON.sm} className="flex-shrink-0 text-amber-600" />
                : <FileText size={ICON.sm} className="flex-shrink-0 text-gray-500 dark:text-neutral-500" />}
              {f.isDir
                ? (
                  <button className="flex-1 min-w-0 text-left truncate hover:underline text-gray-800 dark:text-neutral-200"
                    disabled={busy} onClick={() => void m.sdRefresh(sdJoin(m.sdPath, f.name))}>{f.name}</button>
                )
                : (
                  <button className="flex-1 min-w-0 text-left truncate hover:underline text-gray-800 dark:text-neutral-200"
                    disabled={busy || running} title={isJob(f.name) ? 'Reload it from the card and show it on the map' : 'Load: preview it on the map, ready to run'}
                    onClick={() => pick(f.name)}>{f.name}</button>
                )}
              {!f.isDir && <span className="tabular-nums text-gray-500 dark:text-neutral-500">{f.size}</span>}
              {!f.isDir && (armed === f.name
                ? (
                  <button className="px-1.5 rounded bg-red-600 text-white" onMouseLeave={() => setArmed(null)}
                    onClick={() => { setArmed(null); void m.sdDelete(f.name) }}>Delete?</button>
                )
                : (
                  <button className={`${iconBtn} opacity-0 group-hover:opacity-100 focus:opacity-100`} title="Delete"
                    disabled={busy || running} onClick={() => setArmed(f.name)}>
                    <Trash2 size={ICON.sm} />
                  </button>
                ))}
            </div>
          ))}
      </div>

      {(m.sdBusy || m.sdError) && (
        <div className="px-3 pt-1 flex-shrink-0">
          {m.sdBusy && <p className="text-xs text-gray-600 dark:text-neutral-400">{m.sdBusy}</p>}
          {m.sdError && <p className="text-xs text-red-600 dark:text-red-400">{m.sdError}</p>}
        </div>
      )}

      <div className="p-2 flex-shrink-0">
        <JobBox />
      </div>
    </div>
  )
}

function JobBox() {
  const m = useMachineStore()
  const connected = m.link === 'connected'
  const state = m.position.state
  const idle = connected && state === 'Idle'
  const sd = m.position.sd
  const running = connected && sd !== null
  const held = state === 'Hold'
  const stopped = holdComplete(m.position)
  const job = m.job
  const shown = m.mapSource === 'job' && !!job
  const unzeroed = (['x', 'y', 'z'] as const).filter((a) => !m.zeroed[a]).map((a) => a.toUpperCase()).join(', ')
  const allZeroed = unzeroed === ''
  const pct = sd ? Math.max(0, Math.min(100, sd.percent)) : 0
  return (
    <div className="rounded border border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-900 px-2 py-1.5 space-y-1.5">
      <div className="flex items-center gap-1 text-xs">
        <span className="text-gray-600 dark:text-neutral-400">Job</span>
        <span className="flex-1 min-w-0 truncate font-mono text-gray-800 dark:text-neutral-200">
          {sd?.file || (job ? sdJoin(job.dir, job.name) : <span className="font-sans text-gray-500 dark:text-neutral-500">click a file to load it</span>)}
        </span>
        {job && !running && (
          <button className={iconBtn} title="Unload" onClick={m.unloadJob}><X size={ICON.sm} /></button>
        )}
      </div>
      {job?.preview.warnings.length ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">{job.preview.warnings.join('; ')}</p>
      ) : null}
      {running && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded bg-gray-200 dark:bg-neutral-700 overflow-hidden">
            <div className="h-full bg-blue-600 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs tabular-nums text-gray-600 dark:text-neutral-400">{pct.toFixed(1)}%</span>
        </div>
      )}
      <div className="flex gap-1">
        {!running
          ? (
            <button className={`${btnCls} flex-1 flex items-center justify-center gap-1`} disabled={!idle || !shown || !allZeroed || m.sdBusy !== null} onClick={m.runJob}
              title={!allZeroed ? `Zero ${unzeroed} first (Home & Zero) — the job's coordinates are measured from work zero`
                : m.sdBusy ? `Wait — ${m.sdBusy.replace(/…$/, '')}` : shown ? 'Run this file from the SD card' : job ? 'The map is showing the design — click the job in the list to show it, then Run' : 'Load a file, or Send the design to the card'}>
              <Play size={ICON.sm} /> Run
            </button>
          )
          : held
            ? (
              <button className={`${btnCls} flex-1 flex items-center justify-center gap-1`} onClick={m.resume}>
                <Play size={ICON.sm} /> Resume
              </button>
            )
            : (
              <button className={`${btnCls} flex-1 flex items-center justify-center gap-1`} onClick={m.feedHold}>
                <Pause size={ICON.sm} /> Pause
              </button>
            )}
        {/* Paused, the red button CANCELS: the same reset, held back until the hold
            has fully stopped (Hold:0), when it costs no alarm and no position.
            Running, it is the emergency Stop, which alarms because the axes were
            moving when it landed. */}
        {held && (
          <button className={`${btnCls} flex items-center gap-1 text-red-600 dark:text-red-400`}
            disabled={!stopped} onClick={m.cancelJob}
            title={stopped ? 'Abandon the job here — no alarm, position and zero kept; Z then lifts to the safe height' : 'Waiting for the machine to come to a stop…'}>
            <X size={ICON.sm} /> {stopped ? 'Cancel job' : 'Stopping…'}
          </button>
        )}
        {/* Stop is ALWAYS there while a job is live, paused or not: a way out must
            never depend on the controller reporting what Cancel waits for. Paused
            and stopped, Cancel is the gentler choice, so Stop steps back to an icon. */}
        <button className={`${btnCls} flex items-center gap-1 text-red-600 dark:text-red-400`} disabled={!running && !held}
          onClick={m.softReset}
          title={held
            ? 'Stop now (soft reset). Prefer Cancel once it is available — Stop may alarm if the axes were still moving'
            : 'Stop now (soft reset). The machine alarms, since it was moving — Pause first, then Cancel, to stop without one'}>
          <Square size={ICON.sm} />{!held && ' Stop'}
        </button>
      </div>
      {!running && job && !allZeroed && (
        <p className="text-xs text-amber-700 dark:text-amber-400">Zero {unzeroed} before running.</p>
      )}
      {held && stopped && (
        <p className="text-xs text-gray-600 dark:text-neutral-400">Paused. Resume, or Cancel to end the job here — the spindle stops and Z lifts to the safe height.</p>
      )}
    </div>
  )
}
