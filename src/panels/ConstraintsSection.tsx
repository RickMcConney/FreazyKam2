import { useEffect, useMemo, useRef } from 'react'
import { RotateCw, RulerDimensionLine, X } from 'lucide-react'
import { usePathsStore, useSelectedPathsInOrder, type ImportedPath } from '../store/pathsStore'
import { useConstraintsStore } from '../store/constraintsStore'
import {
  bodiesMovingWith, bodyKeyOf, constraintsInFocus, constraintsHiddenBySelection,
  groundedAxes, measureBetween, refLabel, solveConstraints,
  type Anchor, type Constraint, type GeomRef,
} from '../store/constraints'
import { useWorkpieceStore, fromMM, toMM } from '../store/workpieceStore'
import { useUIStore } from '../store/uiStore'
import { NumericInput } from '../components/NumericInput'
import { uid } from '../uid'

// The Constraints section of the properties panel: hold this part a stated
// distance and direction from that one, and keep it there as either is edited.
//
// ONE CONSTRAINT PER PAIR, HOLDING TWO NUMBERS, and either may be switched off.
// It states them one of two ways (`Constraint.mode`) and the row switches
// between them without moving anything, since both describe the same gap:
//
//  - POLAR, a distance and an angle. Distance alone lets the part swing on its
//    circle, angle alone lets it slide along the ray. How a linkage, a bolt
//    circle or a gear train is dimensioned.
//  - X / Y, two signed offsets. How a hole in the corner of a plate is
//    dimensioned — "15 in from that edge, 20 down from this one" — which as a
//    distance and an angle is arithmetic nobody should have to do. Pick a CORNER
//    with the tool to measure from an actual corner rather than from the middle
//    of an edge.
//
// CREATED FROM WHAT IS ALREADY THERE — the distance and direction the parts
// currently stand at, or wherever the second part was DRAGGED to while it was
// being picked — so adding a constraint never moves anything. That is the CAD
// convention and the only behaviour that lets one be added just to read the
// numbers off before deciding whether to change them.
//
// ONE LINE PER CONSTRAINT: the two numbers and the delete button. Which points
// it hangs off, which end a typed number moves, and which pair of numbers states
// it are all settled by the two clicks that made it — see `ConstraintRow`.

const fieldCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-600 rounded px-1.5 py-0.5 text-body text-gray-800 dark:text-neutral-200 font-mono w-0 focus:outline-none focus:border-blue-500'
const btnCls = 'flex-1 text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300'

const STOCK_EDGES: { edge: 'left' | 'right' | 'bottom' | 'top'; label: string; anchor: Anchor }[] = [
  // The NEAR edge of the part, not its centre: "20 mm in from the left" is a
  // clearance, and it is the edge of the part that has to clear. Reads the same
  // number the eye does.
  { edge: 'left', label: 'Left', anchor: 'minX' },
  { edge: 'right', label: 'Right', anchor: 'maxX' },
  { edge: 'bottom', label: 'Bottom', anchor: 'minY' },
  { edge: 'top', label: 'Top', anchor: 'maxY' },
]

/** The distinct bodies the selection covers, in the order they were clicked. */
function selectedBodies(selected: ImportedPath[]): { key: string; path: ImportedPath }[] {
  const seen = new Set<string>()
  const out: { key: string; path: ImportedPath }[] = []
  for (const p of selected) {
    const key = bodyKeyOf(p)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, path: p })
  }
  return out
}

/**
 * One held number: a label that toggles whether it is held at all, and the box.
 *
 * ONE LINE PER CONSTRAINT is the whole layout, so there is no room for a tick
 * box beside a caption beside a field — the LABEL IS THE TICK. Lit means held;
 * greyed means the parts are free in that respect and the figure beside it is
 * what they currently stand at, so the row goes on answering "how far apart are
 * these" whether or not anything is holding them. Clicking it back on takes up
 * THAT number rather than whatever was last typed, so switching a constraint on
 * never yanks a part across the stock.
 */
function HeldField({ label, title, value, unit, step, min, onChange, onToggle, live, autoFocus }: {
  label: string
  title: string
  value: number | undefined
  unit?: string
  step: number
  min: number
  onChange: (v: number) => void
  onToggle: (on: boolean) => void
  live: number | null
  autoFocus?: boolean
}) {
  const on = value !== undefined
  const box = useRef<HTMLDivElement>(null)
  // The Constrain tool hands the keyboard straight here after its second click,
  // which is the whole point of it: two clicks and then type, without reaching
  // for the sidebar. Focus the real <input> inside, and select it, so the number
  // that is there can simply be replaced.
  useEffect(() => {
    if (!autoFocus || !on) return
    const input = box.current?.querySelector('input[type="text"], input:not([type])') as HTMLInputElement | null
    input?.focus()
    input?.select()
  }, [autoFocus, on])
  return (
    <div ref={box} className="flex items-center gap-1 flex-1 min-w-0">
      <button
        className={['text-label font-mono flex-shrink-0 leading-none',
          on ? 'text-gray-700 dark:text-neutral-200' : 'text-gray-400 dark:text-neutral-500'].join(' ')}
        title={on ? `${title} — held. Click to release it.` : `${title} — not held. Click to hold it here.`}
        onClick={() => onToggle(!on)}
      >
        {label}
      </button>
      {on ? (
        <NumericInput
          value={value!} min={min} step={step} unit={unit} title={title}
          onChange={onChange} className={fieldCls}
        />
      ) : (
        <span className={fieldCls + ' tabular-nums opacity-50'} title={`${title} — not held, free to move`}>
          {live === null ? '—' : (+live.toFixed(2)).toString()}
        </span>
      )}
    </div>
  )
}

/**
 * ONE LINE: the two numbers and the delete button, and nothing else.
 *
 * What used to be here as well — the two end captions, an anchor dropdown on
 * each, a swap arrow and a mode link — made every constraint five rows tall, so
 * a part held off two edges filled the panel and the numbers, the only thing
 * anyone comes here to change, were the smallest part of it. All four are
 * decided by the CONSTRAIN TOOL now: clicking a corner picks the part and the
 * anchor in one gesture, the order of the two clicks sets which end a typed
 * number moves, and the section's own X/Y ↔ Dist/∠ toggle sets how it is
 * stated. What is left is what only this row can do. The ends are still named,
 * in the row's tooltip, so it can be told from its neighbours.
 */
function ConstraintRow({ c, paths, units, stock, badIds, focus }: {
  c: Constraint
  paths: ImportedPath[]
  units: 'mm' | 'in'
  stock: { widthMM: number; heightMM: number }
  badIds: Set<string>
  focus: boolean
}) {
  const updateConstraint = useConstraintsStore((s) => s.updateConstraint)
  const deleteConstraints = useConstraintsStore((s) => s.deleteConstraints)
  const bad = badIds.has(c.id)
  const now = measureBetween(paths, c.from, c.to, stock)
  // An angle against a stock edge means nothing — the point on the edge slides
  // with the part, so the direction is always square to it.
  const canAngle = c.from.kind !== 'stock' && c.to.kind !== 'stock'
  const xy = c.mode === 'xy'
  const step = units === 'in' ? 0.0625 : 1
  const ends = `${refLabel(paths, c.from)} → ${refLabel(paths, c.to)}`

  return (
    <div
      title={`${ends}\nTyping a number holds the first and moves the second. Either can be dragged.`}
      className={['rounded border px-1 py-0.5 flex items-center gap-1',
        bad ? 'border-red-500/60 bg-red-500/10' : 'border-gray-300 dark:border-neutral-700'].join(' ')}
    >
      {xy ? (<>
        <HeldField
          label="X" title={`X offset (${units})`} min={-1e6} step={step} autoFocus={focus}
          value={c.offsetXMM === undefined ? undefined : fromMM(c.offsetXMM, units)}
          live={now ? fromMM(now.offsetXMM, units) : null}
          onChange={(v) => updateConstraint(c.id, { offsetXMM: toMM(v, units) })}
          onToggle={(on) => updateConstraint(c.id, { offsetXMM: on ? (now?.offsetXMM ?? 0) : undefined })}
        />
        <HeldField
          label="Y" title={`Y offset (${units})`} min={-1e6} step={step}
          value={c.offsetYMM === undefined ? undefined : fromMM(c.offsetYMM, units)}
          live={now ? fromMM(now.offsetYMM, units) : null}
          onChange={(v) => updateConstraint(c.id, { offsetYMM: toMM(v, units) })}
          onToggle={(on) => updateConstraint(c.id, { offsetYMM: on ? (now?.offsetYMM ?? 0) : undefined })}
        />
      </>) : (<>
        <HeldField
          label="Dist" title={`Distance (${units})`} min={0} step={step} autoFocus={focus}
          value={c.distanceMM === undefined ? undefined : fromMM(c.distanceMM, units)}
          live={now ? fromMM(now.distanceMM, units) : null}
          onChange={(v) => updateConstraint(c.id, { distanceMM: toMM(v, units) })}
          onToggle={(on) => updateConstraint(c.id, { distanceMM: on ? (now?.distanceMM ?? 0) : undefined })}
        />
        {canAngle && (
          <HeldField
            label="∠" title="Angle (degrees CCW from +X)" unit="°" min={-360} step={1}
            value={c.angleDeg}
            live={now ? now.angleDeg : null}
            onChange={(v) => updateConstraint(c.id, { angleDeg: v })}
            onToggle={(on) => updateConstraint(c.id, { angleDeg: on ? (now?.angleDeg ?? 0) : undefined })}
          />
        )}
      </>)}
      {/* TURNS WITH IT. The third degree of freedom, and the only one with no
          number on the row: it holds the angle the two parts stand at, and that
          angle is read off them rather than typed — so a toggle is the whole of
          the control, and the figure it is holding goes in the tooltip. On by
          default, because a slot that slides to the rotated plate's new corner
          still standing upright is the surprising answer. */}
      {canAngle && (
        <button
          title={c.alignDeg === undefined
            ? `Turn with ${refLabel(paths, c.from)} — hold the angle between them`
            : `Turning with ${refLabel(paths, c.from)}, held at ${+c.alignDeg.toFixed(1)}°. Click to let it turn on its own.`}
          onClick={() => updateConstraint(c.id, {
            alignDeg: c.alignDeg === undefined ? (now?.alignDeg ?? 0) : undefined,
          })}
          className={['flex-shrink-0 w-4 h-4 flex items-center justify-center rounded',
            c.alignDeg === undefined
              ? 'text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300'
              : 'text-blue-600 dark:text-blue-400'].join(' ')}
        >
          <RotateCw size={11} />
        </button>
      )}
      <button
        title={bad
          ? 'Not applied — see the status bar. Delete this constraint (the parts stay where they are).'
          : 'Delete this constraint (the parts stay where they are)'}
        onClick={() => deleteConstraints([c.id])}
        className={['flex-shrink-0 w-4 h-4 flex items-center justify-center rounded hover:text-white hover:bg-red-500',
          bad ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-neutral-400'].join(' ')}
      >
        <X size={11} />
      </button>
    </div>
  )
}

export default function ConstraintsSection() {
  const paths = usePathsStore((s) => s.paths)
  const selected = useSelectedPathsInOrder()
  const constraints = useConstraintsStore((s) => s.constraints)
  const addConstraint = useConstraintsStore((s) => s.addConstraint)
  const { units, widthMM, heightMM } = useWorkpieceStore()
  const activeTool = useUIStore((s) => s.activeTool)
  const constrainMode = useUIStore((s) => s.constrainMode)
  const focusConstraintId = useUIStore((s) => s.focusConstraintId)
  const subjectIds = useUIStore((s) => s.constrainSubjectIds)
  const setActiveTool = useUIStore((s) => s.setActiveTool)
  const setConstrainMode = useUIStore((s) => s.setConstrainMode)
  const constraining = activeTool === 'constrain'


  const bodies = useMemo(() => selectedBodies(selected), [selected])
  // THIS PAIR when two parts are picked, EVERYTHING HOLDING IT when one is —
  // see constraintsForSelection for why "everything touching the selection" made
  // a chain unreadable.
  // The selection's, else the one the tool just made, else what was selected
  // when the tool was entered — see `constraintsInFocus`, which the CANVAS draws
  // from as well so the two can never show different sets.
  const mine = useMemo(
    () => constraintsInFocus(paths, constraints, {
      selectedIds: selected.map((p) => p.id), subjectIds, focusConstraintId,
    }),
    [paths, constraints, selected, focusConstraintId, subjectIds])
  const hidden = useMemo(
    () => constraintsHiddenBySelection(paths, constraints, selected.map((p) => p.id)),
    [paths, constraints, selected])

  // WHAT A DRAG IS ABOUT TO MOVE. There is no root — the solve anchors at
  // whatever the user grabbed and carries the rest of the chain along — so the
  // useful thing to say is how far that reaches, not which part is privileged.
  // The one real refusal left is the stock: ground is ground.
  const dragNote = useMemo(() => {
    if (bodies.length !== 1) return null
    const withIt = bodiesMovingWith(paths, constraints, bodies[0].key)
    const ground = groundedAxes(paths, constraints, bodies[0].key)
    const bits: string[] = []
    if (withIt.size > 0) {
      bits.push(`Dragging this moves ${withIt.size} other part${withIt.size > 1 ? 's' : ''} with it.`)
    }
    if (ground.size === 2) bits.push('Held to the stock — it will not move.')
    else if (ground.size === 1) bits.push(`Held to the stock in ${[...ground][0].toUpperCase()}.`)
    return bits.length > 0 ? bits.join(' ') : null
  }, [bodies, paths, constraints])

  // Which constraints the solver refused, so a row that is not being applied
  // says so instead of showing numbers nothing is holding. The same solve the
  // store runs — it is cheap (translations over a handful of bodies), and asking
  // it here is what keeps the panel and the geometry from ever disagreeing about
  // which constraints are actually being kept.
  const badIds = useMemo(() => {
    if (constraints.length === 0) return new Set<string>()
    return new Set(solveConstraints(paths, constraints, { widthMM, heightMM }).badIds)
  }, [paths, constraints, widthMM, heightMM])

  // Stock constraints only: distance along one axis, no angle (the point on an
  // edge slides with the part, so a direction against it means nothing).
  function create(from: GeomRef, to: GeomRef) {
    const now = measureBetween(paths, from, to, { widthMM, heightMM })
    if (!now) return
    addConstraint({ id: uid('con'), from, to, distanceMM: now.distanceMM })
  }

  // Not `bodies.length === 0` any more: the section is the tool's home while it
  // is on, and it has to be there with nothing selected.
  if (bodies.length === 0 && !constraining && mine.length === 0) return null

  return (
    <div className="mt-2">
      <p className="text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1 flex items-center gap-1">
        <RulerDimensionLine size={14} /> Constraints
      </p>

      {/* THE TOOL IS THE WAY IN. Building a constraint here meant picking two
          shapes, then a mode, then two anchors from dropdowns, then typing —
          five steps, with the anchor chosen away from the geometry it described.
          The Constrain tool collapses that: click a point on one part, click a
          point on another, type. This button and the C key are the way into it,
          and the mode it will use is the one thing worth setting first. */}
      <div className="flex gap-1.5 mb-1">
        <div className="flex flex-1 rounded border border-gray-400 dark:border-neutral-600 overflow-hidden">
          {(['xy', 'polar'] as const).map((m) => (
            <button
              key={m}
              className={['flex-1 text-label py-1 transition-colors',
                constrainMode === m
                  ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300',
              ].join(' ')}
              title={m === 'xy'
                ? 'New constraints hold an X and a Y offset'
                : 'New constraints hold a distance and an angle'}
              onClick={() => setConstrainMode(m)}
            >
              {m === 'xy' ? 'X / Y' : 'Dist / ∠'}
            </button>
          ))}
        </div>
        {/* RIGHTMOST IN BOTH STATES, because in one of them it is the way OUT:
            while the tool is on this button ends the session, and the action
            that finishes a job belongs at the end of the row (the same place
            Generate sits on every machine form). It says FINISHED rather than
            naming the state it is in — a button labelled with what is currently
            happening reads as a status line and gets clicked last, which is the
            opposite of what it is for. Left where it was it would also swap
            sides as the tool turned on, and a control that moves reads as a
            different control. */}
        <button
          className={btnCls + (constraining
            ? ' !border-blue-500 !text-blue-600 dark:!text-blue-400 bg-blue-500/10'
            : '')}
          title={constraining
            ? 'Finish constraining and go back to the select tool — Escape does the same, or drops a half-made constraint first'
            : 'Click a point on one part, then a point on another. Escape to stop.'}
          onClick={() => setActiveTool(constraining ? 'select' : 'constrain')}
        >
          {constraining ? 'Finished' : 'Constrain (C)'}
        </button>
      </div>

      {constraining && mine.length === 0 && (
        <p className="text-label text-blue-600 dark:text-blue-400 mb-1">
          Click a corner, edge or centre on one part, then on another.
        </p>
      )}

      {/* THE STOCK STAYS A BUTTON. It is not a part, so the tool has no marker to
          click on it — holding a part off an edge of the sheet is a different
          gesture and reads better as one. */}
      {bodies.length === 1 && !constraining && (
        <>
          <p className="text-label text-gray-500 dark:text-neutral-400 mb-1">Hold from the stock edge</p>
          <div className="flex gap-1.5">
            {STOCK_EDGES.map((e) => (
              <button
                key={e.edge}
                className={btnCls}
                title={`Hold this part where it is relative to the ${e.label.toLowerCase()} edge of the stock`}
                onClick={() => create(
                  { kind: 'stock', edge: e.edge },
                  { kind: 'path', id: bodies[0].path.id, anchor: e.anchor })}
              >
                {e.label}
              </button>
            ))}
          </div>
        </>
      )}

      {dragNote && (
        <p className="mt-1.5 text-label text-gray-500 dark:text-neutral-400">{dragNote}</p>
      )}

      {mine.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {mine.map((c) => (
            <ConstraintRow
              key={c.id} c={c} paths={paths} units={units}
              stock={{ widthMM, heightMM }} badIds={badIds}
              focus={c.id === focusConstraintId}
            />
          ))}
        </div>
      )}

      {hidden > 0 && (
        <p className="mt-1 text-label text-gray-500 dark:text-neutral-400">
          {hidden === 1 ? '1 more constraint' : `${hidden} more constraints`} on these
          parts — select one part on its own to see them.
        </p>
      )}
    </div>
  )
}
