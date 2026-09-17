// ─── Node Edit / Corner Treatment form ───────────────────────────────────────
import { FormShell, PathChip, LengthInput } from './shared'
import { useState, useEffect, useRef } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, useSelectedPaths } from '../../store/pathsStore'
import { applyCornerTreatments, getTreatableCorners, pathSimilarityTransform, transformPathBySimilarity, type CornerTreatmentType } from '../../tools/cornerTreatment'
import { regenerateAffected } from '../../cam/regenerate'
import { useUIStore } from '../../store/uiStore'

// 'none' removes the treatment on the targeted corners (restores the sharp corner)
type TreatmentChoice = CornerTreatmentType | 'none'

interface NodeEditFormState {
  treatmentType: TreatmentChoice
  radiusMM: number
}

type CornerSession = {
  baseD: string
  treatments: [number, { type: CornerTreatmentType; radiusMM: number }][]
}

// THERE IS NO SESSION CACHE. The recipe lives on the path (ImportedPath.corners):
// every Apply writes it there, a move carries it, undo restores it with the path. A
// module-level copy keyed by path id used to shadow it, and was read IN PREFERENCE:
// change a chamfer's radius, undo, reopen, and the cache still held the undone recipe —
// which no longer reproduced the geometry, so the form threw it away and started fresh
// without ever trying the path's own, correct one, and the treated corners stopped
// being re-pickable.

const CORNER_TREATMENTS: { type: TreatmentChoice; label: string; desc: string; preview: string }[] = [
  { type: 'outerRound', label: 'Outer Round', desc: 'Arc rounding the outside of the corner', preview: '╮' },
  { type: 'innerRound', label: 'Inner Round', desc: 'Concave arc curving into the corner (fillet)', preview: '⌒' },
  { type: 'chamfer',    label: 'Chamfer',     desc: 'Straight bevel cut across the corner', preview: '╱' },
  { type: 'dogbone',    label: 'Dogbone',     desc: 'Circular notch for CNC internal corners', preview: '⦿' },
  { type: 'none',       label: 'None',        desc: 'Remove the treatment and restore the sharp corner', preview: '∟' },
]

export function NodeEditForm({ onClose }: { onClose: () => void }) {
  // Individual selectors, not whole-store destructuring — see DrillForm.
  const batchUpdatePaths = usePathsStore((s) => s.batchUpdatePaths)
  const setNodeEditPathId = useUIStore((s) => s.setNodeEditPathId)
  const setCornerPickSession = useUIStore((s) => s.setCornerPickSession)
  const setTreatedCorners = useUIStore((s) => s.setTreatedCorners)
  const selectedCorners = useUIStore((s) => s.selectedCorners)
  const clearSelectedCorners = useUIStore((s) => s.clearSelectedCorners)
  const load = useFormDefaultsStore((s) => s.load)
  const save = useFormDefaultsStore((s) => s.save)

  const [form, setForm] = useState<NodeEditFormState>(() => {
    const saved = load('nodeedit') as NodeEditFormState | null
    return {
      treatmentType: (saved?.treatmentType ?? 'chamfer') as TreatmentChoice,
      radiusMM: saved?.radiusMM ?? 2,
    }
  })

  // Treatments applied this session, keyed by node index in the baseD snapshot.
  // The path's d is always regenerated from the snapshot, so re-applying to a
  // treated corner replaces its treatment instead of compounding.
  const treatmentsRef = useRef<Map<number, { type: CornerTreatmentType; radiusMM: number }>>(new Map())
  // d we last wrote — distinguishes our own store writes from external edits
  const lastWrittenDRef = useRef<string | null>(null)

  // Clear any active node-edit overlay when this panel closes
  useEffect(() => () => { setNodeEditPathId(null); setCornerPickSession(null, null) }, [])

  const selectedPaths = useSelectedPaths()
  const activePath = selectedPaths.length === 1 ? selectedPaths[0] : null

  // Start (or resume) the corner-pick session: snapshot the path as baseD and
  // show its corners as clickable markers. The recipe stored ON THE PATH is
  // resumed when it still reproduces the current geometry, so treated corners
  // stay pickable after close/reopen — and after an undo, which restores the
  // path's recipe along with its outline. Geometry the recipe no longer describes
  // (a node edit) restarts fresh; our own applies (d === lastWrittenD) keep the
  // live session as is.
  useEffect(() => {
    if (!activePath) {
      setCornerPickSession(null, null)
      treatmentsRef.current.clear()
      lastWrittenDRef.current = null
      return
    }
    // Skip only when this is our own apply landing AND the session is still
    // alive — if the session was torn down, fall through and rebuild it.
    if (activePath.d === lastWrittenDRef.current && useUIStore.getState().cornerPickPathId === activePath.id) return

    // Note: this branch must stay idempotent and must NOT set lastWrittenDRef —
    // resume is not a store write, and under StrictMode's double-mount the
    // cleanup clears the session between the two effect runs; a marked ref
    // would make the second run early-return and leave the session dead.
    // Any similarity transform of the shape (move, rotate, uniform scale,
    // mirror) keeps the session valid: the snapshot is transformed by the same
    // matrix and stored radii scale with it. Non-uniform scale, skew, and node
    // edits genuinely change the corner geometry and start a fresh session.
    // The path is the one home for this (ImportedPath.corners), which is also what
    // lets a corner chip be clicked after a reload or a project load.
    const saved = activePath.corners
    if (saved) {
      const replay = applyCornerTreatments(saved.baseD, new Map(saved.treatments))
      let session: CornerSession | null = null
      if (replay === activePath.d) {
        session = saved
      } else {
        const sim = pathSimilarityTransform(replay, activePath.d)
        if (sim) {
          session = {
            baseD: transformPathBySimilarity(saved.baseD, sim),
            treatments: saved.treatments.map(([i, p]) => [i, { ...p, radiusMM: p.radiusMM * sim.scale }]),
          }
        }
      }
      if (session) {
        treatmentsRef.current = new Map(session.treatments)
        setCornerPickSession(activePath.id, session.baseD)
        setTreatedCorners([...treatmentsRef.current.keys()])
        return
      }
    }

    treatmentsRef.current = new Map()
    lastWrittenDRef.current = null
    setCornerPickSession(activePath.id, activePath.d)
  }, [activePath?.id, activePath?.d])

  function handleApply() {
    if (!activePath) return
    const baseD = useUIStore.getState().cornerPickBaseD ?? activePath.d
    const targets = selectedCorners.length > 0
      ? selectedCorners
      : getTreatableCorners(baseD).map((c) => c.idx)
    for (const idx of targets) {
      if (form.treatmentType === 'none') treatmentsRef.current.delete(idx)
      else treatmentsRef.current.set(idx, { type: form.treatmentType, radiusMM: form.radiusMM })
    }
    const newD = applyCornerTreatments(baseD, treatmentsRef.current)
    if (newD !== activePath.d) {
      lastWrittenDRef.current = newD
      // `corner` records the full current per-corner recipe (not a delta —
      // treatmentsRef is already cumulative) so timeline replay can
      // recompute against whatever this path's geometry becomes upstream,
      // instead of replaying a stale baked d if the shape is edited later
      // at an earlier point in the timeline.
      const corner = [...treatmentsRef.current].map(([idx, p]) => ({ idx, ...p }))
      // `cornerBaseD` goes with it: the recipe means nothing without the outline
      // it was cut from, and storing the pair is what keeps a later edit of the
      // radius re-cutting the ORIGINAL corner rather than rounding a round one.
      batchUpdatePaths([{ id: activePath.id, d: newD, shapeParams: null, corner, cornerBaseD: baseD }], 'corner')
      regenerateAffected(activePath.id)
    }
    setTreatedCorners([...treatmentsRef.current.keys()])
    clearSelectedCorners()
    save('nodeedit', form)
  }

  function up<K extends keyof NodeEditFormState>(k: K, v: NodeEditFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  return (
    <FormShell title="Corners" onClose={onClose}>
      {/* Selected path */}
      <div>
        <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Path</div>
        {activePath ? (
          <PathChip path={activePath} label="selected" />
        ) : (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> Select exactly one path on canvas
          </p>
        )}
      </div>

      {/* Corner treatment section */}
      <div>
        <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Corner Treatment</div>
        <div className="grid grid-cols-2 gap-1">
          {CORNER_TREATMENTS.map(({ type, label, desc }) => (
            <button
              key={type}
              title={desc}
              onClick={() => up('treatmentType', type)}
              className={[
                'py-1.5 px-2 rounded border text-body text-left transition-colors',
                form.treatmentType === type
                  ? 'border-blue-500 bg-blue-500/20 text-blue-300'
                  : 'border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-700',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Radius (not applicable to None) */}
      <div>
        {form.treatmentType !== 'none' && (
          <>
            <label htmlFor="nodeedit-f3" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
              {form.treatmentType === 'dogbone' ? 'Tool Radius' : 'Radius'}
            </label>
            <LengthInput id="nodeedit-f3"
              valueMM={form.radiusMM}
              minMM={0.01}
              stepMM={0.5}
              onChangeMM={(v) => up('radiusMM', v)}
              className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 font-mono focus:outline-none focus:border-blue-500"
            />
          </>
        )}
        <p className="text-label text-gray-600 dark:text-neutral-400 mt-0.5">
          {form.treatmentType === 'none'
            ? 'Removes the treatment from the picked corners (or all corners if none are picked), restoring the original sharp corners.'
            : 'Click corner markers on the canvas to pick specific corners; with none picked, all sharp corners are treated. Treated corners (green) stay pickable — re-applying replaces their treatment. Use Undo to revert.'}
        </p>
      </div>

      {selectedCorners.length > 0 && (
        <div className="flex items-center justify-between text-body text-gray-500 dark:text-neutral-400">
          <span>{selectedCorners.length} corner{selectedCorners.length === 1 ? '' : 's'} selected</span>
          <button
            onClick={clearSelectedCorners}
            className="text-label text-blue-400 hover:text-blue-300 transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      <button
        disabled={!activePath}
        onClick={handleApply}
        className="w-full py-1.5 rounded text-body font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-500 text-white"
      >
        {selectedCorners.length > 0
          ? `Apply to ${selectedCorners.length} Selected Corner${selectedCorners.length === 1 ? '' : 's'}`
          : 'Apply to All Corners'}
      </button>
    </FormShell>
  )
}
