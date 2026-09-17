import { useEffect, useState } from 'react'
import { AlertTriangle, Info, CheckCircle2, X } from 'lucide-react'
import { ICON } from '../theme'
import { rigidityInfo } from '../rigidity'
import { useProjectStore } from '../store/projectStore'
import type { ExportPreflight } from '../cam/exportPreflight'
import { fmtLen, fmtFeed } from '../store/workpieceStore'

function fmtDuration(s: number): string {
  if (s <= 0) return '—'
  const t = Math.round(s)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  if (h > 0) return `~${h}h ${m}m`
  if (m > 0) return `~${m}m ${sec}s`
  return `~${sec}s`
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span className="text-gray-500 dark:text-neutral-400">{label}</span>
      <span className="text-gray-800 dark:text-neutral-200 text-right font-mono">{value}</span>
    </div>
  )
}

// Pre-export summary + safety warnings. The user must acknowledge by pressing
// Export; Cancel aborts. (PRD REQ-184/185, 327, 335.)
export default function ExportPreflightDialog({
  report,
  onConfirm,
  onCancel,
}: {
  report: ExportPreflight
  onConfirm: (splitByTool: boolean, prefix: string) => void
  onCancel: () => void
}) {
  const { machine, job, warnings, units, stock } = report
  const ext = job.extents
  const rig = rigidityInfo(machine.rigidity)
  const RigIcon = rig.Icon
  const hasWarnings = warnings.length > 0
  const canSplit = job.tools.length > 1
  const projectName = useProjectStore((s) => s.name)
  const [splitByTool, setSplitByTool] = useState(false)
  // Only the split export names its own files: it writes a whole set into a folder the
  // directory picker can't name them in. A single-file export is named in the OS save
  // dialog instead, so it gets no field here.
  const [prefix, setPrefix] = useState(() => (projectName === 'Untitled Project' ? '' : projectName))

  // Esc closes the dialog. (Enter is intentionally not bound — Export should be a
  // deliberate click in a review dialog.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onCancel() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div
        className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[460px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-neutral-700 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100 flex items-center gap-2.5">
            <RigIcon size={30} className={rig.color} />
            <span><span className={rig.color}>{rig.label}</span> · G-code review</span>
          </h2>
          <button onClick={onCancel} className="text-gray-600 hover:text-gray-800 dark:hover:text-neutral-200 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4 flex flex-col gap-4 text-[13px]">
          {!report.hasToolpaths ? (
            <p className="text-amber-600 dark:text-amber-400">
              No visible, generated toolpaths to export. Create or show an operation first.
            </p>
          ) : (
            <>
              {/* Warnings, or an all-clear confirmation when there are none */}
              {hasWarnings ? (
                <div className="flex flex-col gap-2">
                  {warnings.map((w, i) => (
                    <div
                      key={i}
                      className={[
                        'flex items-start gap-2 rounded-md px-3 py-2',
                        w.level === 'warn'
                          ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900'
                          : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900',
                      ].join(' ')}
                    >
                      {w.level === 'warn' ? <AlertTriangle size={ICON.sm} className="mt-0.5 flex-shrink-0" /> : <Info size={ICON.sm} className="mt-0.5 flex-shrink-0" />}
                      <span className="leading-relaxed">{w.text}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-md px-3 py-2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900">
                  <CheckCircle2 size={ICON.sm} className="flex-shrink-0" />
                  <span>No issues found — safety checks passed.</span>
                </div>
              )}

              {/* Machine settings */}
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-neutral-400 mb-1">Machine</h3>
                <Row label="Post-processor" value={machine.profileName} />
                <Row label="Output units" value={machine.outputUnits === 'in' ? 'inch' : 'mm'} />
                <Row label="Work origin (XY)" value={machine.origin.replace(/-/g, ' ')} />
                <Row
                  label="Z origin"
                  value={machine.zOrigin === 'bottom'
                    ? `Bottom of stock — set Z0 at the spoilboard/table surface`
                    : `Top of stock — set Z0 at the top surface`}
                />
                <Row label="Safe height" value={fmtLen(machine.safeHeightMM, units, 1)} />
                <Row label="Max feed" value={fmtFeed(machine.maxFeedMmMin, units)} />
                <Row label="Spindle range" value={`${machine.minSpindleRpm}–${machine.maxSpindleRpm} RPM`} />
                <Row label="Auto feeds & speeds" value={machine.autoFeed ? 'On' : 'Off'} />
              </section>

              {/* Stock */}
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-neutral-400 mb-1">Stock</h3>
                <Row label="Size" value={`${fmtLen(stock.widthMM, units, 1)} × ${fmtLen(stock.heightMM, units, 1)}`} />
                <Row label="Thickness" value={fmtLen(stock.thicknessMM, units, 1)} />
              </section>

              {/* Job summary */}
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-neutral-400 mb-1">Job</h3>
                <Row label="Operations" value={String(job.operationCount)} />
                <Row label="Estimated run time" value={fmtDuration(job.estimatedTimeS)} />
                {ext && <Row label="Deepest cut" value={fmtLen(job.deepestCutMM, units, 1)} />}
              </section>

              {/* Tools */}
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-neutral-400 mb-1">
                  Tools ({job.tools.length})
                </h3>
                <div className="flex flex-col gap-0.5">
                  {job.tools.map((t, i) => (
                    <div key={i} className="flex justify-between gap-4 py-0.5">
                      <span className="text-gray-800 dark:text-neutral-200">{i + 1}. {t.name}</span>
                      <span className="text-gray-500 dark:text-neutral-400 font-mono text-right">
                        {fmtLen(t.diameterMM, units, 1)} · {t.rpm} RPM
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <p className="text-[12px] text-gray-600 dark:text-neutral-400 leading-relaxed border-t border-gray-200 dark:border-neutral-700 pt-3">
                Simulation is not a substitute for a dry run. Verify the work origin, Z-zero, and tool before cutting.
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 px-5 py-3 border-t border-gray-200 dark:border-neutral-700 flex-shrink-0">
          {canSplit && splitByTool && (
            <div className="flex items-center gap-2">
              <label htmlFor="export-file-prefix" className="text-[13px] text-gray-600 dark:text-neutral-400 whitespace-nowrap">File prefix</label>
              <input
                id="export-file-prefix"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="gcode"
                autoFocus
                className="flex-1 min-w-0 text-sm bg-gray-100 dark:bg-neutral-700 text-gray-900 dark:text-neutral-100 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <span className="text-[12px] text-gray-600 dark:text-neutral-400 font-mono whitespace-nowrap">_1_tool.gcode</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            {canSplit ? (
              <label className="flex items-center gap-2 text-[13px] text-gray-600 dark:text-neutral-400 cursor-pointer" title="Write a separate, standalone file for each tool so you can change the tool and spindle speed by hand between files.">
                <input
                  type="checkbox"
                  checked={splitByTool}
                  onChange={(e) => setSplitByTool(e.target.checked)}
                  className="accent-blue-500"
                />
                Split into one file per tool
              </label>
            ) : <span />}
            <div className="flex gap-2">
              <button
                onClick={onCancel}
                className="px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => onConfirm(canSplit && splitByTool, prefix)}
                disabled={!report.hasToolpaths}
                className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
              >
                {splitByTool && canSplit ? `Export ${job.tools.length} files` : hasWarnings ? 'Export anyway' : 'Export'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
