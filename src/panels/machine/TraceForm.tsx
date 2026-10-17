// ─── Trace form ───────────────────────────────────────────────────────────────
// Turns an image path's picture into closed vector outlines (tools/imageTrace). The
// outlines are ordinary paths — profile, pocket or v-carve them like any import — and
// carry a `trace` definition, so the chip reopens this form and Update re-traces them.
import { FormShell, PathChip, PathListSection, ToggleRow, GenerateBtn, CheckRow, FormError } from './shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { ICON } from '../../theme'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, useSelectedPaths, type ImportedPath } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { regenerateAffectedMany } from '../../cam/regenerate'
import { loadImageLuminance } from '../../io/imageLuminance'
import { extractRectInfo } from '../../canvas/selectionUtils'
import { autoThreshold, multiOtsu, DEFAULT_TRACE, type TraceParams, type TraceResult } from '../../tools/imageTrace'
import { runInWorkerFor, cancelWork, isWorkCancelled } from '../../workers/workerClient'
import type { PhotoImage } from '../../cam/photoVcarve'
import { traceColors } from '../../tools/traceColors'
import { tracePaths } from '../../tools/pathToolActions'
import { uid } from '../../uid'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'

// Worker-pool key for this form's traces: a new request cancels whatever is still running.
const TRACE_JOB = 'trace-image'

export interface TraceEditCtx {
  defId: string
}

export function TraceForm({ onClose, editCtx }: { onClose: () => void; editCtx?: TraceEditCtx }) {
  const paths = usePathsStore((s) => s.paths)
  const selPaths = useSelectedPaths()
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)

  // The trace this form is editing: the chip's, or the one the last Trace click made —
  // so the first result can be tuned in place rather than traced again beside itself.
  const [defId, setDefId] = useState<string | null>(editCtx?.defId ?? null)
  const defPaths = defId ? paths.filter((p) => p.definition?.id === defId) : []
  const def0 = defPaths[0]?.definition
  const defParams = def0?.kind === 'trace' ? def0 : null

  const source: ImportedPath | undefined = defParams
    ? paths.find((p) => p.id === defParams.sourceId)
    : selPaths.find((p) => !!p.imageSrc)

  const [form, setForm] = useState<TraceParams>(() => {
    if (defParams) return { ...DEFAULT_TRACE, ...defParams.params }
    return { ...DEFAULT_TRACE, ...(load('trace') as Partial<TraceParams> | null) }
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A preview trace is running in the worker.
  const [tracing, setTracing] = useState(false)

  // Decode once per picture; the loader caches by data URL as well.
  const [image, setImage] = useState<PhotoImage | null>(null)
  useEffect(() => {
    setImage(null)
    if (!source?.imageSrc) return
    let live = true
    loadImageLuminance(source.imageSrc).then((img) => { if (live) setImage(img) }, (e) => { if (live) setError(String(e?.message ?? e)) })
    return () => { live = false }
  }, [source?.imageSrc])
  const autoTs = useMemo(() => image ? { dark: autoThreshold(image.lum, 'dark'), light: autoThreshold(image.lum, 'light') } : null, [image])
  const autoT = autoTs ? autoTs[form.trace] : null

  // The TRACE, not the thresholded picture: the outlines the current settings make,
  // filled even-odd, so smoothing and speck removal show as well as the threshold. A
  // dropped speck takes the colour around it — a light fleck in a dark area fills dark,
  // a dark one in a light area vanishes — because dropping a loop is all removal does.
  // One trace per change, at full size where the picture sits: drawn small here and full
  // size on the canvas, and exactly what Trace will make.
  const previewRef = useRef<HTMLCanvasElement>(null)
  const [preview, setPreview] = useState<{ count: number; specks: number; thresholds: number[] } | { error: string } | null>(null)
  const rect = source ? extractRectInfo(source.d) : null
  const centerline = form.mode === 'centerline'
  const groupId = defPaths[0]?.groupId
  // The settings (and picture placement) last locked in by Trace / Update. While the form
  // still matches them the canvas shows the real paths; any change and it shows the preview.
  const settingsKey = JSON.stringify(form) + '|' + (source?.d ?? '')
  // Reopening an existing trace starts locked: its settings ARE what is on the canvas.
  const lockedKey = useRef<string | null>(defParams ? settingsKey : null)
  useEffect(() => {
    if (!image || !rect) { setPreview(null); useUIStore.getState().setTracePreview(null); return }
    let live = true
    const t = setTimeout(async () => {
      cancelWork(TRACE_JOB)
      let r: TraceResult
      try {
        // Traced where the picture actually sits, so the same result is drawn full size on
        // the canvas (TracePreviewLayer) and small here. Off the main thread: a big or
        // mostly-ink picture takes a second or more, and the sliders must stay live.
        setTracing(true)
        r = await runInWorkerFor(TRACE_JOB, 'traceImage', image, rect, form)
      } catch (e) {
        if (!live || isWorkCancelled(e)) return
        setTracing(false)
        setPreview({ error: e instanceof Error ? e.message : String(e) })
        useUIStore.getState().setTracePreview(null)
        return
      }
      if (!live) return
      setTracing(false)
      const cv = previewRef.current
      {
        setPreview({ count: r.ds.length, specks: r.specks, thresholds: r.thresholds })
        useUIStore.getState().setTracePreview(lockedKey.current === settingsKey
          ? null : { ds: r.ds, colors: traceColors(r.levels, r.thresholds.length), groupId })
        const ctx = cv?.getContext('2d')
        if (cv && ctx) {
          const cw = 640, ch = Math.max(1, Math.round(cw * rect.heightMM / rect.widthMM))
          cv.width = cw; cv.height = ch
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, cw, ch)
          // Stock mm → this canvas: undo the picture's placement (p0, rotation), scale its
          // rectangle onto the canvas, and flip Y (the stock is Y-up, the canvas Y-down).
          const kx = cw / rect.widthMM, ky = ch / rect.heightMM
          const c = Math.cos(rect.rotationDeg * Math.PI / 180), sn = Math.sin(rect.rotationDeg * Math.PI / 180)
          const { x: x0, y: y0 } = rect.p0
          ctx.setTransform(kx * c, ky * sn, kx * sn, -ky * c, -kx * (c * x0 + sn * y0), ch + ky * (c * y0 - sn * x0))
          // Centerlines are drawn as strokes the width they will read at on the canvas.
          if (centerline) {
            ctx.strokeStyle = '#000000'
            ctx.lineWidth = 2 / kx
            ctx.lineJoin = 'round'; ctx.lineCap = 'round'
            ctx.stroke(new Path2D(r.ds.join(' ')))
          }
          // Levels nest, so the outermost is painted first and each inner one over it:
          // level 1 black, the outermost a light grey.
          const n = centerline ? 0 : r.thresholds.length
          for (let l = n; l >= 1; l--) {
            const g = n === 1 ? 0 : Math.round(170 * (l - 1) / (n - 1))
            ctx.fillStyle = `rgb(${g},${g},${g})`
            ctx.fill(new Path2D(r.ds.filter((_, i) => r.levels[i] === l).join(' ')), 'evenodd')
          }
          ctx.setTransform(1, 0, 0, 1, 0, 0)
        }
      }
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [image, form, source?.d, groupId]) // eslint-disable-line react-hooks/exhaustive-deps
  // The canvas preview belongs to this form: gone when it closes.
  useEffect(() => () => { cancelWork(TRACE_JOB); useUIStore.getState().setTracePreview(null) }, [])

  // The speck slider's reach: a twentieth of the picture's short side, so it is useful on
  // a coaster and on a sign alike.
  const maxSpeckMM = rect ? Math.max(1, Math.round(Math.min(rect.widthMM, rect.heightMM) / 20)) : 5
  const units = useWorkpieceStore((s) => s.units)
  // Thickening is a tool's worth at most: past a few millimetres the shapes run together.
  const maxThickenMM = rect ? Math.max(1, Math.min(6, Math.round(Math.min(rect.widthMM, rect.heightMM) / 30))) : 3

  function up<K extends keyof TraceParams>(k: K, v: TraceParams[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  // Multi-tone break points: the brightness histogram the slider draws over, and the
  // automatic cuts for the current tone count (ascending, as the slider shows them).
  const tones = form.tones ?? 2
  const hist = useMemo(() => {
    if (!image) return null
    const h = new Float64Array(256)
    for (let i = 0; i < image.lum.length; i++) h[image.lum[i]]++
    return h
  }, [image])
  const autoCutsFor = (n: number) => image && n > 2 ? multiOtsu(image.lum, n).map((t) => Math.max(1, Math.min(254, Math.round(t)))) : null
  const autoCuts = useMemo(() => autoCutsFor(tones), [image, tones]) // eslint-disable-line react-hooks/exhaustive-deps
  // What traceThresholds will use: the manual cuts only while Auto is off and they fit.
  const shownCuts = !form.autoThreshold && form.cuts?.length === tones - 1 ? [...form.cuts].sort((a, b) => a - b) : autoCuts

  // Changing the tone count while the cuts are manual starts the new count from ITS
  // automatic cuts (or the two-tone auto cut), still manual, rather than from stale ones.
  function setTones(n: number) {
    setForm((f) => {
      if (f.autoThreshold) return { ...f, tones: n }
      if (n === 2) return { ...f, tones: n, threshold: autoT ?? f.threshold }
      return { ...f, tones: n, cuts: autoCutsFor(n) ?? f.cuts }
    })
  }

  function handleApply() {
    setError(null)
    if (!source || !image) return
    if (!rect) { setError('This image is no longer a rectangle — undo the edit that reshaped it, or re-import the image'); return }
    setBusy(true)
    cancelWork(TRACE_JOB)
    void (async () => {
      try {
        const r = await runInWorkerFor(TRACE_JOB, 'traceImage', image, rect, form)
        if (r.ds.length === 0) { setError('Nothing to trace at this threshold — move it, or switch Dark/Light'); return }
        const id = defId ?? uid('def')
        const groupId = defPaths[0]?.groupId ?? uid('grp-trace')
        // Each tone level is a LAYER, so Select Only → Layers picks one out to pocket or
        // inlay on its own, and the canvas colours them apart.
        const noun = centerline ? 'lines' : 'outlines'
        const newPaths = tracePaths(source, r, form, id, groupId)
        const store = usePathsStore.getState()
        if (defPaths.length > 0) {
          // The number of outlines changes with the settings, so a re-trace replaces the
          // set rather than reshaping it path for path.
          store.rewriteGeneratedRaw({ add: newPaths, deleteIds: defPaths.map((p) => p.id) })
          regenerateAffectedMany(newPaths.map((p) => p.id))
          useUIStore.getState().showStatus(`Trace updated — ${newPaths.length} ${noun}`, 'info')
        } else {
          store.addPaths(newPaths, { source: 'trace' })
          setDefId(id)
          // The picture sits under its own trace and hides it; Show Image brings it back.
          store.setPathsVisible([source.id], false)
          useUIStore.getState().showStatus(`Traced ${newPaths.length} ${noun}`, 'info')
        }
        store.setSelectedIds(newPaths.map((p) => p.id))
        save('trace', form)
        // Locked in: the canvas now shows the real paths until a setting changes again.
        lockedKey.current = settingsKey
        useUIStore.getState().setTracePreview(null)
      } catch (e) {
        if (!isWorkCancelled(e)) setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
        setTracing(false)   // a preview it cancelled never reports back
      }
    })()
  }

  const editing = defPaths.length > 0
  const canApply = !!source && !!image && !busy

  return (
    <FormShell title={editing ? 'Edit Trace' : 'Trace Image'} onClose={onClose}>
      {!source && (
        <p className="text-body text-amber-600 dark:text-amber-400">
          {defParams ? 'The traced image no longer exists' : 'Select an imported image first'}
        </p>
      )}
      <ToggleRow label="Trace" options={['dark', 'light'] as const} value={form.trace}
        labels={{ dark: 'Dark areas', light: 'Light areas' }} onChange={(v) => up('trace', v)} />

      <ToggleRow label="Trace As" options={['outline', 'centerline'] as const} value={form.mode ?? 'outline'}
        labels={{ outline: 'Outlines', centerline: 'Centerlines' }} onChange={(v) => up('mode', v)} />
      {centerline && (
        <p className="text-label text-gray-600 dark:text-neutral-400 -mt-1">
          One open path down the middle of each stroke — cut with a V-bit on a centerline Profile. Solid areas come out as their middle line
        </p>
      )}

      {!centerline && <ToggleRow label="Tones" options={['2', '3', '4'] as const} value={String(tones) as '2' | '3' | '4'}
        onChange={(v) => setTones(parseInt(v))} />}
      {!centerline && tones > 2 && <div>
        <label className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Break Points <span className="text-gray-500 dark:text-neutral-400 normal-case">
            {shownCuts ? shownCuts.join(', ') : '…'}{form.autoThreshold && ' (auto)'}
          </span>
        </label>
        {shownCuts && hist && <ToneCutsSlider cuts={shownCuts} hist={hist} trace={form.trace}
          onChange={(c) => setForm((f) => ({ ...f, cuts: c, autoThreshold: false }))} />}
        <CheckRow id="trace-auto-cuts" checked={form.autoThreshold}
          onChange={(v) => setForm((f) => ({ ...f, autoThreshold: v, cuts: v ? f.cuts : (autoCuts ?? f.cuts) }))}
          label="Auto" hint="from the picture's histogram" />
        <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
          Drag a break to move where one tone ends and the next begins. Each tone is its own layer, tone 1 the {form.trace === 'dark' ? 'darkest' : 'lightest'}; they nest, so tone 1 lies inside tone 2
        </p>
      </div>}

      {(centerline || tones === 2) && <div>
        <label htmlFor="trace-threshold" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Threshold <span className="text-gray-500 dark:text-neutral-400 normal-case">
            {form.autoThreshold ? (autoT !== null ? `${autoT} (auto)` : 'auto') : form.threshold}
          </span>
        </label>
        {hist && <ToneCutsSlider id="trace-threshold" cuts={[form.autoThreshold ? (autoT ?? form.threshold) : form.threshold]}
          hist={hist} trace={form.trace}
          onChange={(c) => setForm((f) => ({ ...f, threshold: c[0], autoThreshold: false }))} />}
        <CheckRow id="trace-auto" checked={form.autoThreshold}
          onChange={(v) => setForm((f) => ({ ...f, autoThreshold: v, threshold: v ? f.threshold : (autoT ?? f.threshold) }))}
          label="Auto" hint="from the picture's histogram" />
      </div>}

      <div>
        <label htmlFor="trace-smooth" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Smoothing <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.smoothing === 0 ? 'off — straight lines' : form.smoothing}</span>
        </label>
        <input id="trace-smooth" type="range" min={0} max={100} step={5}
          value={form.smoothing} onChange={(e) => up('smoothing', parseInt(e.target.value))}
          className="w-full accent-blue-500" />
      </div>

      <div>
        <label htmlFor="trace-speck" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Ignore Specks Under <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.minSpeckMM === 0 ? 'off' : fmtLen(form.minSpeckMM, units)}</span>
        </label>
        <input id="trace-speck" type="range" min={0} max={maxSpeckMM} step={maxSpeckMM / 100}
          value={Math.min(form.minSpeckMM, maxSpeckMM)} onChange={(e) => up('minSpeckMM', parseFloat(e.target.value))}
          className="w-full accent-blue-500" />
        <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">A speck takes the colour around it: light flecks in dark areas fill in, dark ones in light areas go{!centerline && tones > 2 && '. A lighter tone squeezed into a gap or a V narrower than this joins the darker tone round it'}</p>
      </div>

      {!centerline && <div>
        <label htmlFor="trace-thicken" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          Thicken Lines <span className="text-gray-500 dark:text-neutral-400 normal-case">{(form.thickenMM ?? 0) === 0 ? 'off' : `+${fmtLen(form.thickenMM ?? 0, units)}`}</span>
        </label>
        <input id="trace-thicken" type="range" min={0} max={maxThickenMM} step={maxThickenMM / 100}
          value={Math.min(form.thickenMM ?? 0, maxThickenMM)} onChange={(e) => up('thickenMM', parseFloat(e.target.value))}
          className="w-full accent-blue-500" />
        <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">Widens every line by this much, so a tool fits to pocket it</p>
      </div>}

      {image && (
        <canvas ref={previewRef} aria-label="What will be traced"
          className="w-full rounded border border-gray-400 dark:border-neutral-600" />
      )}
      {tracing && <p className="text-label text-gray-500 dark:text-neutral-400">Tracing…</p>}
      {!tracing && preview && ('error' in preview
        ? <p className="text-label text-amber-600 dark:text-amber-400">{preview.error}</p>
        : <p className="text-label text-gray-600 dark:text-neutral-400">
            {preview.count} {centerline ? 'line' : 'outline'}{preview.count === 1 ? '' : 's'}{preview.specks > 0 && `, ${preview.specks} speck${preview.specks === 1 ? '' : 's'} ignored`}
          </p>)}
      <FormError msg={error} />
      <GenerateBtn disabled={!canApply} generating={busy} onClick={handleApply} label={editing ? 'Update Trace' : 'Trace'} />
      {source && (
        <button
          onClick={() => usePathsStore.getState().setPathsVisible([source.id], !source.visible)}
          title={source.visible ? 'Hide the picture so the trace can be seen' : 'Show the picture under the trace'}
          className="w-full flex items-center justify-center gap-1.5 text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
        >
          {source.visible ? <><EyeOff size={ICON.sm} /> Hide Image</> : <><Eye size={ICON.sm} /> Show Image</>}
        </button>
      )}
      <PathListSection count={source ? 1 : 0} toggle={false}>
        {source && <PathChip path={source} label="image" />}
      </PathListSection>
    </FormShell>
  )
}

// ─── Break-point slider ───────────────────────────────────────────────────────
// One track, one thumb per cut, over the picture's brightness histogram (black left,
// white right) so the breaks can be dropped into the valleys between its tones. Each
// band is labelled with the tone it falls in; the band past the last break is the
// untraced background.
function ToneCutsSlider({ id, cuts, hist, trace, onChange }: {
  id?: string; cuts: number[]; hist: Float64Array; trace: 'dark' | 'light'; onChange: (cuts: number[]) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useRef<number | null>(null)

  // Square-root heights, so a small middle tone still shows beside a big white ground.
  const histD = useMemo(() => {
    let max = 0
    for (let i = 0; i < 256; i++) max = Math.max(max, Math.sqrt(hist[i]))
    if (max === 0) return ''
    let d = 'M0,1'
    for (let i = 0; i < 256; i++) { const y = 1 - Math.sqrt(hist[i]) / max; d += `L${i},${y}L${i + 1},${y}` }
    return d + 'L256,1Z'
  }, [hist])

  // Each cut stays strictly between its neighbours, so the tones never swap order.
  function setCut(i: number, v: number) {
    const lo = i === 0 ? 1 : cuts[i - 1] + 1
    const hi = i === cuts.length - 1 ? 254 : cuts[i + 1] - 1
    const c = Math.max(lo, Math.min(hi, Math.round(v)))
    if (c !== cuts[i]) onChange(cuts.map((x, j) => (j === i ? c : x)))
  }
  const valueAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    return ((clientX - r.left) / r.width) * 255
  }

  function onPointerDown(e: React.PointerEvent) {
    const v = valueAt(e.clientX)
    // The nearest thumb; on a tie (two stacked thumbs) the one on the side clicked.
    let best = 0
    for (let i = 1; i < cuts.length; i++) {
      const d = Math.abs(cuts[i] - v), bd = Math.abs(cuts[best] - v)
      if (d < bd || (d === bd && v > cuts[i])) best = i
    }
    drag.current = best
    e.currentTarget.setPointerCapture(e.pointerId)
    ;(e.currentTarget.querySelectorAll('[role="slider"]')[best] as HTMLElement | undefined)?.focus()
    setCut(best, v)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (drag.current !== null) setCut(drag.current, valueAt(e.clientX))
  }
  function onPointerUp() { drag.current = null }

  function onKeyDown(i: number, e: React.KeyboardEvent) {
    const step = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setCut(i, cuts[i] - step); e.preventDefault() }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setCut(i, cuts[i] + step); e.preventDefault() }
  }

  // Bands from black to white: [0, c1), [c1, c2), …, [c_last, 255]. Dark: tone 1 is the
  // first band and the last is background; light: the reverse.
  const edges = [0, ...cuts, 255]
  const n = cuts.length
  const bandLabel = (b: number) => {
    const tone = trace === 'dark' ? b + 1 : n + 1 - b
    return tone === n + 1 ? '–' : String(tone)
  }

  return (
    <div className="select-none">
      <div ref={trackRef} className="relative h-12 cursor-pointer touch-none rounded border border-gray-400 dark:border-neutral-600 overflow-visible"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <svg className="absolute inset-x-0 top-0 h-9 w-full text-gray-400 dark:text-neutral-500" viewBox="0 0 256 1" preserveAspectRatio="none" aria-hidden>
          <path d={histD} fill="currentColor" />
        </svg>
        <div className="absolute inset-x-0 bottom-0 h-3 rounded-b" style={{ background: 'linear-gradient(to right, #000, #fff)' }} aria-hidden />
        {edges.slice(0, -1).map((a, b) => (
          <span key={b} aria-hidden
            className="absolute top-0 text-label text-gray-600 dark:text-neutral-300 -translate-x-1/2 pointer-events-none"
            style={{ left: `${((a + edges[b + 1]) / 2 / 255) * 100}%` }}>{bandLabel(b)}</span>
        ))}
        {cuts.map((c, i) => (
          <div key={i} id={i === 0 ? id : undefined} role="slider" tabIndex={0} aria-label={cuts.length === 1 ? 'Threshold' : `Break ${i + 1}`}
            aria-valuemin={1} aria-valuemax={254} aria-valuenow={c}
            onKeyDown={(e) => onKeyDown(i, e)}
            className="absolute top-0 bottom-0 w-3 -ml-1.5 flex justify-center outline-none group"
            style={{ left: `${(c / 255) * 100}%` }}>
            <div className="w-0.5 h-full bg-blue-500 group-focus-visible:bg-blue-300" />
            <div className="absolute bottom-0 w-3 h-3 rounded-full bg-blue-500 border-2 border-white dark:border-neutral-900 group-focus-visible:ring-2 ring-blue-300" />
          </div>
        ))}
      </div>
    </div>
  )
}
