// ─── Along Path form ──────────────────────────────────────────────────────────
// Lays a Text object's letters along a guide path — round a circle, along a curve — as one
// new path (tools/alongPath). The original text is hidden, not deleted, so it can be shown
// again from the paths list, and one undo puts everything back. The result carries an `along`
// definition (text, guide, settings), so its chip reopens this form and Apply re-lays the
// letters in place — over the text and guide as they are NOW, so editing either and
// re-applying picks the change up.
//
// The form asks only what you can see: which SIDE of the line the letters stand on and a
// slider for WHERE along it they go. Which way the guide is travelled follows from those
// (tools/alongPath), so the text always reads left to right, upright.
import { FormShell, PathChip, PathListSection, GenerateBtn, LengthInput } from './shared'
import { useEffect, useMemo, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { ICON } from '../../theme'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, useSelectedPathsInOrder, type ImportedPath } from '../../store/pathsStore'
import { regenerateAffectedMany } from '../../cam/regenerate'
import { useUIStore } from '../../store/uiStore'
import { textGlyphRuns, loadFont, isFontLoaded, type TextParams } from '../../shapes/textGenerator'
import { layoutAlongPath, guideOf, type AlongSide, type AlongPathOptions } from '../../tools/alongPath'
import { uid } from '../../uid'

const DEFAULTS: AlongPathOptions = { side: 'out', at: 0.5, spacingMM: 0, gapMM: 0, rotate: true }

const isText = (p: ImportedPath) => p.shapeParams?.type === 'text'

/** A closed guide's `at` (clockwise from the bottom) put in words, near the four sides. */
function roundName(at: number): string {
  const names = ['bottom', 'left', 'top', 'right', 'bottom']
  const q = at * 4, i = Math.round(q)
  return Math.abs(q - i) < 0.02 ? names[i] : `${Math.round(at * 100)}% round`
}

export interface AlongEditCtx {
  /** The Text on Path result being edited. */
  pathId: string
}

export function AlongPathForm({ onClose, editCtx }: { onClose: () => void; editCtx?: AlongEditCtx }) {
  const sel = useSelectedPathsInOrder()
  const paths = usePathsStore((s) => s.paths)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)

  // Editing: the result, and what it was made from — read off its definition, not the
  // selection (the text is hidden, and the chip click selected only the result).
  const editing = editCtx ? paths.find((p) => p.id === editCtx.pathId) : undefined
  const def = editing?.definition?.kind === 'along' ? editing.definition : null

  const [f, setF] = useState<AlongPathOptions>(() => {
    if (def) return { ...DEFAULTS, ...def.params }
    const saved = (load('alongpath') ?? {}) as Record<string, unknown>
    const ok = <K extends keyof AlongPathOptions>(k: K) => (typeof saved[k] === typeof DEFAULTS[k] ? saved[k] : DEFAULTS[k]) as AlongPathOptions[K]
    const side = (['out', 'on', 'in'] as unknown[]).includes(saved.side) ? (saved.side as AlongSide) : DEFAULTS.side
    return { side, at: ok('at'), spacingMM: ok('spacingMM'), gapMM: ok('gapMM'), rotate: ok('rotate') }
  })
  const up = <K extends keyof AlongPathOptions>(k: K, v: AlongPathOptions[K]) => setF((s) => ({ ...s, [k]: v }))

  const text = def ? paths.find((p) => p.id === def.sourceId) : sel.find(isText)
  // A guide is any selected path that is not a text, a picture, or (editing) the result
  // itself. Editing, selecting one swaps the text onto it — the way the other forms take a
  // path added on the canvas — and with none selected the text stays on the guide it has.
  const isGuide = (p: ImportedPath) => !isText(p) && !p.imageSrc && p.id !== editing?.id
  const oldGuide = def ? paths.find((p) => p.id === def.guideId) : undefined
  const picked = sel.find(isGuide)
  const guide = picked ?? oldGuide
  const swapping = !!def && !!picked && picked.id !== def.guideId
  const params = text?.shapeParams?.type === 'text' ? (text.shapeParams as TextParams) : null

  const closed = useMemo(() => (guide ? guideOf(guide.d)?.closed ?? true : true), [guide?.d]) // eslint-disable-line react-hooks/exhaustive-deps

  // The text's font is normally loaded already — it is on the canvas — but a project opened
  // cold may not have it yet.
  const [, setFontTick] = useState(0)
  useEffect(() => {
    if (params && !isFontLoaded(params.fontFamily)) loadFont(params.fontFamily).then(() => setFontTick((t) => t + 1))
  }, [params?.fontFamily]) // eslint-disable-line react-hooks/exhaustive-deps

  const result = useMemo(() => {
    if (!params || !guide) return null
    const runs = textGlyphRuns(params)
    if (!runs) return null
    return layoutAlongPath(runs, params.fontSize, guide.d, f)
  }, [params, guide?.d, f]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drawn on the canvas as it will be made, while the form is open. Editing, the result
  // itself is kept off the canvas meanwhile (it would sit under the preview, in the old place).
  const color = editing?.color ?? text?.color
  useEffect(() => {
    useUIStore.getState().setTracePreview(result && color
      ? { ds: [result], colors: [color], ...(editing?.groupId ? { groupId: editing.groupId } : {}) }
      : null)
  }, [result, color, editing?.groupId])
  useEffect(() => () => useUIStore.getState().setTracePreview(null), [])

  function handleApply() {
    if (!result || !text || !guide) return
    const definition = { id: def?.id ?? uid('def'), kind: 'along' as const, sourceId: text.id, guideId: guide.id, params: f }
    if (editing) {
      // Re-laid in place: same path, so the operations and tabs on it carry on.
      usePathsStore.getState().rewriteGeneratedRaw({ updates: [{ id: editing.id, d: result, definition }] })
      regenerateAffectedMany([editing.id])
      useUIStore.getState().setTracePreview(null)
      save('alongpath', f)
      onClose()
      return
    }
    // A group of one, so the preview can hide it while it is being edited (see above).
    const made: ImportedPath = {
      id: uid('path-along'), name: `${text.name} on path`, d: result, visible: true, color: text.color,
      groupId: uid('grp-along'), groupName: `${text.name} on path`, definition,
    }
    usePathsStore.getState().applyPathEdit({
      gesture: 'along',
      add: [made],
      updates: [{ id: text.id, d: text.d, hidden: true }],
      selectAfter: [made.id],
    })
    useUIStore.getState().setTracePreview(null)
    save('alongpath', f)
    onClose()
  }

  const missing = def && !text ? 'The text this was made from no longer exists'
    : def && !guide ? 'The path this was laid along no longer exists'
    : !text ? 'Select a Text object and the path to lay it along'
    : !guide ? 'Also select the path to lay the text along'
      : !params ? 'That text has no text settings'
        : !result ? 'Loading the font…' : null

  return (
    <FormShell title={editing ? 'Edit Text Along Path' : 'Text Along Path'} onClose={onClose}>
      {missing && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.sm} /> {missing}
        </p>
      )}
      <div>
        <label className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Letters</label>
        <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Letters">
          {([['out', closed ? 'Outside' : 'Above'], ['on', 'On Line'], ['in', closed ? 'Inside' : 'Below']] as [AlongSide, string][]).map(([v, label]) => (
            <Choice key={v} on={f.side === v} label={label} onClick={() => up('side', v)}>
              {closed ? <CircleIcon side={v} /> : <LineIcon side={v} />}
            </Choice>
          ))}
        </div>
      </div>
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <label htmlFor="along-at" className="text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider">Position</label>
          <span className="text-label text-gray-600 dark:text-neutral-400">
            {closed ? roundName(f.at) : `${Math.round(f.at * 100)}%`}
          </span>
        </div>
        <input id="along-at" type="range" min={0} max={1} step={0.005} value={f.at}
          onChange={(e) => up('at', Number(e.target.value))} className="w-full accent-blue-500" />
        <div className="flex justify-between text-label text-gray-600 dark:text-neutral-400">
          {closed
            ? <><span>bottom</span><span>left</span><span>top</span><span>right</span><span>bottom</span></>
            : <><span>start</span><span>end</span></>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="along-rotate" checked={f.rotate}
          onChange={(e) => up('rotate', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="along-rotate" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Rotate letters <span className="text-gray-600 dark:text-neutral-400">(turn each with the path)</span>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="along-spacing" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Letter Spacing</label>
          <LengthInput id="along-spacing" valueMM={f.spacingMM} minMM={-50} maxMM={200} stepMM={0.5} onChangeMM={(v) => up('spacingMM', v)} />
        </div>
        <div>
          <label htmlFor="along-gap" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Gap From Line</label>
          <LengthInput id="along-gap" valueMM={f.gapMM} minMM={-50} maxMM={200} stepMM={0.5} onChangeMM={(v) => up('gapMM', v)} />
        </div>
      </div>
      <GenerateBtn disabled={!result || !text || !guide} generating={false} onClick={handleApply} label={editing ? "Update" : "Apply"} />
      {def && !swapping && (
        <p className="text-label text-gray-600 dark:text-neutral-400">
          Select another path on the canvas to lay the text along it instead.
        </p>
      )}
      <PathListSection count={(text ? 1 : 0) + (guide ? 1 : 0)} toggle={false}>
        {text && <PathChip path={text} label="text" />}
        {swapping && oldGuide && <PathChip path={oldGuide} label="path" state="removed" />}
        {guide && <PathChip path={guide} label="path" state={swapping ? 'added' : undefined} />}
      </PathListSection>
    </FormShell>
  )
}

function Choice({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick}
      className={`flex flex-col items-center gap-0.5 py-1 rounded border text-label ${on
        ? 'border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400'
        : 'border-gray-300 dark:border-neutral-600 text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700'}`}>
      {children}
      {label}
    </button>
  )
}

// The letters drawn as a thick band beside a thin circle — outside, on or inside it.
function CircleIcon({ side }: { side: AlongSide }) {
  const cx = 18, cy = 14, r = 8
  const R = side === 'out' ? 11.5 : side === 'on' ? r : 4.5
  const a = (50 * Math.PI) / 180
  const x1 = cx - R * Math.sin(a), x2 = cx + R * Math.sin(a), y = cy - R * Math.cos(a)
  return (
    <svg width="36" height="28" viewBox="0 0 36 28" aria-hidden>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeOpacity={0.5} strokeWidth={1} />
      <path d={`M${x1} ${y} A${R} ${R} 0 0 1 ${x2} ${y}`} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </svg>
  )
}

// The same for an open line: the band above, on or below it.
function LineIcon({ side }: { side: AlongSide }) {
  const y = side === 'out' ? 9 : side === 'on' ? 14 : 19
  return (
    <svg width="36" height="28" viewBox="0 0 36 28" aria-hidden>
      <line x1={2} y1={14} x2={34} y2={14} stroke="currentColor" strokeOpacity={0.5} strokeWidth={1} />
      <line x1={10} y1={y} x2={26} y2={y} stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </svg>
  )
}
