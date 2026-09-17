// The clock designer.
//
// Everything mechanical is in shapes/clockTrain.ts; this panel is the numbers a
// clockmaker actually dials in, the readouts that say what came of them, and the
// button that lays the parts out on the stock.
//
// The one design decision worth restating here: it emits INDEPENDENT SHAPES,
// one chip each — four wheels, an escapement and a pendulum for the default
// three-wheel train — not a single "clock" shape. A wheel's bore, hub, spoke
// count, backlash and markings are all things a maker changes per wheel once the
// train is settled, and a shape is one set of parameters. So the clock passes
// each wheel only what the train forces on it — its tooth count, the pins of the
// pinion it drives, the module and the cycloidal profile — and takes everything
// else from the user's own Gear and Escapement defaults. After the click there
// is no clock left in the document, only ordinary shapes that happen to mesh,
// each editable through its own chip in the usual way.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Info, Lock, LockOpen } from 'lucide-react'
import { ICON } from '../../theme'
import { useUIStore } from '../../store/uiStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { regenerateAffectedMany } from '../../cam/regenerate'
import { generateShapeParts, translateShapeParams, carryAnnotationSwitches } from '../../shapes/shapeGenerators'
import { loadFont, SINGLE_LINE_FONT_FAMILY } from '../../shapes/textGenerator'
import {
  DEFAULT_CLOCK_SPEC, designClock, layoutClock, MAX_WHEEL_DIA, MODULE_TAPER, MOTION_CENTRE_MM,
  clockAssemblyFromPaths, clockMotionFromPaths, holdCutModules, meshCountOf, trainWheelsOf,
  type ClockPart, type ClockPartParams, type ClockSpec,
} from '../../shapes/clockTrain'
import { nextPathColor, type ImportedPath } from '../../importers/svgImporter'
import { uid } from '../../uid'
import { NumInput, PlainInput, Check, Select, noteCls } from './shared'
import { clockReadout } from '../clockReadout'
import { TONE_BTN } from '../readout'

const LS_CLOCK_KEY = 'kam:clockSpec'

/** The wheels the train solver has to place, in mesh order — the first two on a
 *  three-wheel train, all three on a four-wheel one. The drive wheel and the
 *  escape wheel are not among them: one follows the run time and the other sets
 *  the ratio these divide. */
const ALL_WHEEL_NAMES = ['Great', 'Second', 'Third'] as const

// Margin from the stock edge, and daylight between parts. Both generous: these
// are big wheels, and a clock that lands overlapping its own stock edge is more
// annoying to fix than one that needs nudging in.
// Kept off the stock edges when deciding how wide a row may get, and daylight
// between parts. The block itself is centred, so the margin only decides where
// rows wrap.
const MARGIN = 10
const GAP = 12

/**
 * One wheel's tooth count: what the solver worked out, editable, with a lock.
 *
 * TYPING IS LOCKING. A count the user has typed is a count they want kept, and
 * making them type it and then press a padlock to make it stick would be a trap
 * — the next spinner step on any other field would silently take it away again.
 * The padlock is therefore only ever used to LET GO (or to hold what the solver
 * chose, without retyping it).
 */
function TeethRow({ label, teeth, locked, onLock, title }: {
  label: string; teeth: number; locked: boolean
  onLock: (v: number | null) => void
  title: string
}) {
  return (
    <div className="flex items-center gap-1" title={title}>
      <div className="flex-1 min-w-0">
        <NumInput label={label} valueMM={teeth} units="" min={6} integer onChange={(t) => onLock(Math.max(6, Math.round(t)))} />
      </div>
      <button
        onClick={() => onLock(locked ? null : teeth)}
        title={locked
          ? `Held at ${teeth} teeth — click to let the train solver choose again`
          : `Solved: ${teeth} teeth. Click to hold it and let the others move`}
        className={`p-1 rounded border flex-shrink-0 transition-colors ${locked
          ? 'border-blue-500 bg-blue-500/20 text-blue-500'
          : 'border-gray-400 dark:border-neutral-600 text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300'}`}
      >
        {locked ? <Lock size={11} /> : <LockOpen size={11} />}
      </button>
    </div>
  )
}

export default function ClockPanel() {
  const setClockPanelOpen = useUIStore((s) => s.setClockPanelOpen)
  const clockInfoOpen = useUIStore((s) => s.clockInfoOpen)
  const setClockInfoOpen = useUIStore((s) => s.setClockInfoOpen)
  const shapeToolConfig = useUIStore((s) => s.shapeToolConfig)
  const showStatus = useUIStore((s) => s.showStatus)
  // Set when a clock chip was clicked: the panel then REWRITES that clock's
  // parts rather than emitting a second one, which is what lets a beat or a
  // tooth count be tried without starting the project over.
  const clockEditId = useUIStore((s) => s.clockEditId)
  // Both previews are addressed by a PATH — the canvas layers pick the clock up
  // from whichever path they are handed — so any part of this clock will do.
  // The RUNNING test is keyed on the CLOCK rather than on that path, so the
  // buttons say Stop for a clock already running whichever of its parts was
  // handed over. Selectors return primitives: a fresh object or function from a
  // zustand selector compares unequal every render.
  const clockAnimPathId = useUIStore((s) => s.clockAnimPathId)
  const clockLinkPathId = useUIStore((s) => s.clockLinkPathId)
  const setClockAnim = useUIStore((s) => s.setClockAnim)
  const setClockLink = useUIStore((s) => s.setClockLink)
  const anyClockPathId = usePathsStore((s) => s.paths.find((p) => p.clockId === clockEditId)?.id ?? null)
  const animClockId = usePathsStore((s) => s.paths.find((p) => p.id === clockAnimPathId)?.clockId ?? null)
  const linkClockId = usePathsStore((s) => s.paths.find((p) => p.id === clockLinkPathId)?.clockId ?? null)
  const clockRunning = !!clockEditId && animClockId === clockEditId
  const clockArranging = !!clockEditId && linkClockId === clockEditId
  const { units, widthMM, heightMM } = useWorkpieceStore()
  const [spec, setSpec] = useState<ClockSpec>(DEFAULT_CLOCK_SPEC)
  const [reLayout, setReLayout] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Editing an existing clock starts from ITS spec — carried by its own parts —
    // not from whatever was last typed into a fresh one.
    if (clockEditId) {
      const own = usePathsStore.getState().paths.find((p) => p.clockId === clockEditId && p.clockSpec)
      // MERGING OVER THE DEFAULTS IS WRONG FOR `trainWheels` AND ONLY FOR IT.
      // Every other absent field means "this clock predates the field, give it
      // today's answer"; this one means "this clock was CUT as a four-wheel
      // train", and taking the default would show three wheels over a clock that
      // has four — and delete its third wheel on the next Update. `trainWheelsOf`
      // is the one reader that knows that, so it fills the gap here.
      if (own?.clockSpec) {
        // …and a wheel RE-CUT on its own chip since is taken up as a held module
        // (`holdCutModules`). Without that the designer went on reporting the
        // tooth size it had solved for — so the numbers window gave the arbor
        // spacing of the wheel that used to be there — and the next Update cut
        // the wheel back to it. Typing is locking, exactly as it is for a tooth
        // count; the rest of the train then re-cuts AROUND the held wheel,
        // which is what puts the pins it drives back on its pitch circle. A
        // motion wheel comes back as the "Arbor spacing" below instead — the
        // same fact in the term this panel actually offers, and the only handle
        // those two wheels have.
        const paths = usePathsStore.getState().paths
        setSpec(holdCutModules(
          {
            ...DEFAULT_CLOCK_SPEC, ...own.clockSpec,
            trainWheels: trainWheelsOf(own.clockSpec),
          },
          useUIStore.getState().shapeToolConfig,
          clockAssemblyFromPaths(paths, clockEditId),
          clockMotionFromPaths(paths, clockEditId),
        ))
        return
      }
    }
    const saved = localStorage.getItem(LS_CLOCK_KEY)
    if (!saved) return
    try {
      // Merged over the defaults, so a spec saved before a field existed still
      // loads — the same rule project files follow.
      const remembered = JSON.parse(saved)
      // …except that the wheel count and the pin floor are ONE decision, and a
      // spec remembered from before there was a choice carries a `minPins` typed
      // for the four-wheel train. Pairing a saved 12 with the new default of
      // three wheels asks two meshes to come to 60:1 on 12-pin pinions, which
      // wants ~93-tooth wheels — so a spec that predates the field gives up its
      // pin floor along with its wheel count. These are the numbers a NEW clock
      // starts from, not a clock that exists, so nothing is being re-cut.
      if (remembered.trainWheels === undefined) delete remembered.minPins
      setSpec({ ...DEFAULT_CLOCK_SPEC, ...remembered })
    } catch {}
  }, [clockEditId])

  const set = (patch: Partial<ClockSpec>) => {
    const next = { ...spec, ...patch }
    setSpec(next)
    // Only a NEW clock's numbers become the remembered defaults. An edit belongs
    // to that clock and is carried on its chip.
    if (!clockEditId) localStorage.setItem(LS_CLOCK_KEY, JSON.stringify(next))
  }

  // The whole design. Cheap apart from the tooth geometry, which `designClock`
  // does not touch — it only builds parameters.
  const base = useMemo(
    () => ({ gear: shapeToolConfig.gear, escapement: shapeToolConfig.escapement, pendulum: shapeToolConfig.pendulum }),
    [shapeToolConfig.gear, shapeToolConfig.escapement, shapeToolConfig.pendulum],
  )
  const design = useMemo(() => designClock(spec, base), [spec, base])

  const L = (mm: number) => fmtLen(mm, units)

  // The wheels THIS train has, and one lock entry per mesh — a short or missing
  // array must read as "nothing held", not as undefined rows. Trimmed to the
  // mesh count so a clock stepped down from four wheels to three does not keep
  // holding a count for a wheel it no longer cuts.
  const wheelNames = ALL_WHEEL_NAMES.slice(0, meshCountOf(spec))
  const locks: (number | null)[] = wheelNames.map((_, i) => spec.lockedTeeth?.[i] ?? null)

  // Everything derived lives in the floating readout now; the panel keeps only
  // its TONE, for the button that stands for it.
  const readout = useMemo(
    () => clockReadout(spec, base, { widthMM, heightMM }, L),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, base, widthMM, heightMM, units],
  )
  const problems = readout.sections.flatMap((sec) => sec.lines).filter((l) => l.tone === 'error' || l.tone === 'warn').length
  const summary = problems === 0 ? 'Numbers' : `Numbers · ${problems} to check`

  // The window follows the spec being designed, which lives here rather than in
  // any store — so it is published for the window to read, and withdrawn when
  // this panel unmounts so a stale draft cannot outlive the designer.
  const setClockDraft = useUIStore((s) => s.setClockDraft)
  useEffect(() => { setClockDraft(spec) }, [spec, setClockDraft])
  useEffect(() => () => setClockDraft(null), [setClockDraft])

  // WHAT CLOSES THIS PANEL is picking something ELSE. It fills the whole Draw tab
  // and suppresses the properties panel (Sidebar's `showProps`), so leaving it up
  // over a gear the user has just clicked shows them nothing about that gear.
  // Adding or updating a clock does NOT close it — that selects the clock's own
  // parts, and a run of small changes is how one is designed.
  //
  // An EMPTY selection leaves it alone: clicking bare canvas is deselecting, not
  // choosing something else to look at.
  // It watches for a CHANGE, not for a state: the selection the panel was opened
  // over is none of its business — a clock chip opens it without touching the
  // selection at all, and a user who had a gear selected when they reached for
  // the Clock button would otherwise see the panel shut the instant it appeared.
  // `selectedIds` is replaced rather than mutated, so identity is the test.
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const lastSel = useRef(selectedIds)
  useEffect(() => {
    const changed = lastSel.current !== selectedIds
    lastSel.current = selectedIds
    if (!changed || selectedIds.length === 0) return
    const paths = usePathsStore.getState().paths
    const mine = !!clockEditId
      && selectedIds.every((id) => paths.find((p) => p.id === id)?.clockId === clockEditId)
    if (!mine) setClockPanelOpen(false)
  }, [selectedIds, clockEditId, setClockPanelOpen])

  // Arranging is a canvas MODE — dragging moves link joints instead of selecting
  // — and its only way out is the button above, so it ends when this panel does.
  // Leaving it on with the panel shut would leave the canvas behaving oddly with
  // nothing on screen to explain why. The ANIMATION is left running on purpose:
  // it is a preview, it changes no interaction, and the clock's chip brings the
  // Stop button back in one click — the same way a gear's mesh preview outlives
  // the selection that started it.
  useEffect(() => () => {
    const ui = useUIStore.getState()
    if (ui.clockLinkPathId) ui.setClockLink(null)
  }, [])

  // Where a fresh clock's parts land: CENTRED on the stock, rows running right
  // and wrapping downward. Centred rather than packed into a corner because
  // these are big — an m4 48-tooth wheel is 200 mm across against a 300 mm
  // stock, so most parts take a row to themselves and a corner-anchored pack
  // comes out as a column against one edge, trailing off the bottom.
  //
  // THE STOCK'S CENTRE IN PATH SPACE IS SIMPLY (w/2, h/2). The stock rectangle
  // is drawn at x=0,y=0,w,h (WorkpieceLayer), so path space always has the stock
  // at [0,w]×[0,h] whatever the XY origin says — `originWorldXY` is a DISPLAY and
  // G-code offset, applied on the way out, and every one of its other callers is
  // an emitter or a readout. Subtracting it here moved the whole clock by −origin:
  // to the left of the stock for a corner origin, onto the lower-left corner for
  // a centred one.
  const layout = () => layoutClock(design.parts, { widthMM, heightMM }, MARGIN, GAP)

  /** Every path of one clock part, so its whole group can be regenerated. */
  const groupOf = (pathId: string) => {
    const st = usePathsStore.getState()
    const self = st.paths.find((p) => p.id === pathId)
    if (!self) return [pathId]
    return st.paths.filter((p) => p.groupId === self.groupId && p.shapePart !== undefined).map((p) => p.id)
  }

  const emitPart = (part: ClockPart, clockId: string): string[] => {
    const geo = generateShapeParts(part.params)
    if (!geo || geo.length === 0) return []
    const groupId = uid('shape-group')
    const color = nextPathColor()
    const made: ImportedPath[] = geo.map((g) => ({
      id: uid('shape'), name: `${part.name} ${g.label}`, d: g.d,
      visible: true, color, shapeParams: part.params, shapePart: g.part,
      groupId, groupName: part.name,
      clockId, clockPart: part.key, clockSpec: spec,
    }))
    // One addPaths per part, so each wheel gets its OWN chip — that chip is then
    // what every later parameter edit on that wheel amends (updateShapeParams →
    // amendShapeGroup), exactly as a hand-drawn gear's does. One call for all of
    // them would give one chip that owns the lot.
    usePathsStore.getState().addPaths(made, { source: 'shape', label: part.name })
    return made.map((p) => p.id)
  }

  const run = async () => {
    setBusy(true)
    try {
      // A gear's tooth-count marking is set in the single-stroke face, which is
      // fetched on demand — a gear generated before it lands simply has no
      // marking part. A trainful of wheels is worth waiting for it once.
      if (shapeToolConfig.gear.toothLabel) await loadFont(SINGLE_LINE_FONT_FAMILY)

      const { setSelectedIds, updateShapeParams } = usePathsStore.getState()
      const selected: string[] = []

      if (clockEditId) {
        // ── Rewrite an existing clock ──────────────────────────────────────
        // Each part goes through `updateShapeParams`, which regenerates its whole
        // group (adding and dropping paths as parts appear and vanish) and
        // AMENDS that part's own chip. So re-running is an argument edit to the
        // calls that made the clock, not a second clock — no chip piles up and
        // no operation loses its path.
        //
        // `laid` is computed once whether or not it is used for the parts that
        // already exist: a part that has to be ADDED has nowhere of its own to
        // stay, so it always takes a laid-out position.
        const laid = layout()
        let rebuilt = 0, added = 0
        for (let i = 0; i < design.parts.length; i++) {
          const part = design.parts[i]
          const existing = usePathsStore.getState().paths
            .find((p) => p.clockId === clockEditId && p.clockPart === part.key)
          if (!existing) {
            // Deleted, or a part this clock predates (a pendulum on a clock made
            // before there were pendulums). A new chip is the only thing an edit
            // may legitimately add.
            emitPart(laid[i], clockEditId)
            added++
            continue
          }
          // Held where it already sits unless a re-layout was asked for: a maker
          // who has arranged the parts on the stock should not lose that to a
          // spinner step.
          const old = existing.shapeParams
          const placed = reLayout || !old || !('cx' in old)
            ? laid[i].params
            : translateShapeParams(part.params, old.cx, old.cy) as ClockPartParams
          // A wheel's parameters are re-derived from the train and the user's
          // Gear defaults, which would hand back a marking or a pitch circle
          // that has been DELETED off this wheel — deleting one turns its switch
          // off (ANNOTATION_SWITCH), and that switch belongs to the wheel, not
          // to the design. Nothing else is carried: re-deriving the rest is what
          // Update clock is for.
          const params = carryAnnotationSwitches(old, placed) as ClockPartParams
          updateShapeParams(existing.id, params)
          const ids = groupOf(existing.id)
          regenerateAffectedMany(ids)
          selected.push(...ids)
          rebuilt++
        }
        // A part the design no longer HAS goes with it — turning the motion work
        // off is the only way to get here, and leaving two orphaned wheels
        // behind, still stamped with this clock, would be the wrong answer to
        // "update clock". One undo puts them and their operations back.
        const wanted = new Set(design.parts.map((p) => p.key as string))
        const orphans = usePathsStore.getState().paths
          .filter((p) => p.clockId === clockEditId && p.clockPart && !wanted.has(p.clockPart))
        if (orphans.length > 0) {
          usePathsStore.getState().applyPathEdit({
            deleteIds: orphans.map((p) => p.id),
            label: 'Clock parts removed',
          })
        }

        // Every part carries the spec, so re-running restamps all of them —
        // including parts of groups that updateShapeParams has just rewritten.
        // Not recorded: the parts' own chips already record the rebuild, and the
        // spec is a property of them rather than an edit in its own right.
        const clockPaths = usePathsStore.getState().paths.filter((p) => p.clockId === clockEditId)
        usePathsStore.getState().rewriteGeneratedRaw({
          updates: clockPaths.map((p) => ({ id: p.id, d: p.d, clockSpec: spec })),
        })
        // Selection is only meaningful for parts that were rewritten; a run that
        // rebuilt nothing left the document alone but for whatever it added.
        if (selected.length > 0) setSelectedIds(selected)
        const dropped = orphans.length > 0 ? `, ${orphans.length} paths removed` : ''
        showStatus(rebuilt === 0
          ? `No parts of that clock are in the document — ${added} rebuilt from scratch.`
          : `Clock updated — ${rebuilt} parts rebuilt${added > 0 ? `, ${added} added` : ''}${dropped}.`)
        return
      }

      // ── A fresh clock ────────────────────────────────────────────────────
      // Links the parts back together. NOT a container: they stay ordinary
      // independent shapes and nothing regenerates through it. It exists so the
      // set can be found again — to be stood up in mesh, and to be redesigned.
      const clockId = uid('clock')
      for (const part of layout()) selected.push(...emitPart(part, clockId))
      // The panel STAYS OPEN and turns into that clock's editor, so a beat or a
      // tooth count can be tried straight away — and the Arrange/Animate buttons,
      // which only exist for a clock that is in the document, appear at once. The
      // edit id has to be set BEFORE the selection: the effect above closes this
      // panel for a selection that is not the clock being edited, and these parts
      // only ARE that clock once it knows which clock it is editing.
      useUIStore.getState().setClockEdit(clockId)
      setSelectedIds(selected)
      showStatus(`Clock added — ${design.parts.length} parts. Change anything and press Update clock.`)
    } catch (err) {
      showStatus(`Could not build the clock: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
        <span className="flex items-center gap-1.5 text-body font-semibold text-gray-700 dark:text-neutral-300">
          <Clock size={ICON.sm} /> {clockEditId ? 'Edit clock' : 'Clock'}
        </span>
        <button
          onClick={() => setClockPanelOpen(false)}
          className="text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 text-sm leading-none"
        >
          ✕
        </button>
      </div>

      {/* Inputs only. Everything derived went to the floating readout — see
          clockReadout.ts — which is what stopped this list pushing the button
          that builds the clock off the bottom of the tab. */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Pendulum</p>
          {/* The beat is HALF a period — the number a clock is described by. */}
          <PlainInput label="Beat" value={spec.beatSeconds} unit="s" min={0.1} max={4} step={0.05}
            onChange={(beatSeconds) => set({ beatSeconds })} />
          <NumInput label="Esc teeth" valueMM={spec.escapeTeeth} units="" min={6} integer
            onChange={(t) => set({ escapeTeeth: Math.max(6, Math.round(t)) })} />
        </div>

        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Going train</p>
          {/* HOW MANY WHEELS, and it is the first thing to decide because
              everything below it moves: the mesh count, the pin count that makes
              those meshes possible, and which way the escape wheel runs. Three
              is the classic English longcase train and what a wooden clock
              wants — fewer pivots and one fewer mesh to lose torque in, which is
              what a wooden train is always short of. Four is kept because every
              clock designed before this existed has one. */}
          <Select label="Wheels" value={String(trainWheelsOf(spec))}
            options={[['3', '3 — great, second, escape'], ['4', '4 — with a third wheel']]}
            onChange={(v) => {
              const trainWheels = v === '3' ? 3 : 4
              // Holds are per WHEEL, so a train that just lost its third wheel
              // must lose that wheel's hold with it — leaving it would pin a
              // count onto a wheel the solver is no longer placing.
              const kept = spec.lockedTeeth?.slice(0, trainWheels - 1)
              set({ trainWheels, lockedTeeth: kept?.some((x) => x != null) ? kept : undefined })
            }} />
          <NumInput label="Min pins" valueMM={spec.minPins} units="" min={6} integer
            onChange={(p) => set({ minPins: Math.max(6, Math.round(p)) })} />
          {/* THE TRAIN WHEELS, as the solver has them — type one and the
              others move to keep the ratio exact. Two of them on a three-wheel
              train, three on a four-wheel one. The escape wheel is above (it
              sets the ratio rather than dividing it) and the drive wheel is
              below (its count follows the run time, not the rate). */}
          {wheelNames.map((name, i) => (
            <TeethRow
              key={name}
              label={name}
              teeth={design.train.meshes[i]?.teeth ?? 0}
              locked={locks[i] !== null}
              title={`${name} wheel — drives a ${design.train.meshes[i]?.pins ?? 0}-pin pinion`}
              onLock={(v) => {
                const next = locks.slice()
                next[i] = v
                set({ lockedTeeth: next.some((x) => x !== null) ? next : undefined })
              }}
            />
          ))}
          <p className={noteCls}>
            {locks.every((l) => l === null)
              ? `Solved for ${+design.train.actualRatio.toFixed(4)}:1 · drive ${design.drive.teeth}t follows the run · escape ${spec.escapeTeeth}t`
              : `${locks.filter((l) => l !== null).length} held — the rest move to keep ${+design.train.targetRatio.toFixed(4)}:1`}
          </p>
          <PlainInput label="Great" value={spec.greatWheelMin} unit="min/rev" min={1} max={1440} step={1}
            onChange={(greatWheelMin) => set({ greatWheelMin })} />
          {/* SIZE, NOT TOOTH SIZE. One module for the clock made wheel diameter
              `m × z` with `z` forced by the rate, so nothing about how big the
              wheels came out was anyone's choice — the default train was three
              ~200 mm wheels whatever the board. What a maker has instead is the
              width of the board, so that is the input and tooth size is scaled
              to it; the taper then makes the drive end coarse and the escape end
              fine, which is what a real clock does, torque falling by the mesh
              ratio at every step. Set the taper to 1 for one module throughout.
              Every mesh's module is reported in the info window. */}
          <NumInput label="Max wheel Ø" valueMM={spec.maxWheelDia ?? MAX_WHEEL_DIA} units={units} min={20} step={10}
            onChange={(maxWheelDia) => set({ maxWheelDia })} />
          <PlainInput label="Tooth taper" value={+(spec.toothTaper ?? MODULE_TAPER).toFixed(2)} unit="×/mesh"
            min={0.3} max={1} step={0.05}
            onChange={(toothTaper) => set({ toothTaper })} />
          {/* One figure each for the WHOLE clock. Both are decisions about how
              the wheels are cut rather than about any one wheel — and the pin
              diameter shapes a cycloidal tooth, so wheels disagreeing about it
              are cut for pins that are not in the clock. Set per chip they meant
              opening seven forms to change one thing. */}
          <NumInput label="Backlash" valueMM={spec.backlash} units={units} min={0} step={0.05}
            onChange={(backlash) => set({ backlash })} />
          {/* TWO DOWELS, not one. The tooth is `π·m − pin Ø − backlash` and the
              pin is an absolute rod, so a pin that suits the great wheel is most
              of the tooth space at the escape end and one that suits the escape
              end rattles in the great wheel's. The slow end takes the fattest of
              the two its TOOTH can still push (`pinForTooth`) and the fast end
              takes the small one regardless; the info window says which mesh got
              which. Set them equal for one pin throughout. */}
          <NumInput label="Pin Ø large" valueMM={spec.pinDia} units={units} min={0.5} step={0.5}
            onChange={(pinDia) => set({ pinDia })} />
          <NumInput label="Pin Ø small" valueMM={spec.pinDiaFine ?? spec.pinDia} units={units} min={0.5} step={0.5}
            onChange={(pinDiaFine) => set({ pinDiaFine })} />
        </div>

        {/* The hour hand's gearing. Two more wheels of the same kind, off the
            great arbor rather than along the train — so it changes no rate, and
            the counts are forced by both meshes spanning the same pair of
            arbors (see solveMotionWork). */}
        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Hour hand</p>
          <Check label="Motion work" checked={!!spec.motionWork}
            onChange={(motionWork) => set({ motionWork })} />
          {/* THE ONE FREE NUMBER, and it is a DISTANCE. The ratios and the equal
              centre distance fix the counts, which are the classic 10/30 and
              8/32, so `C = 10·k·m` leaves exactly one — and as a spacing in mm
              it is a continuum, where the old `k` stepped it in 50 mm jumps. It
              is also the number the plate is drilled from and the one that walks
              the stud clear of a big great wheel. The module falls out of it. */}
          {spec.motionWork && (
            <NumInput label="Arbor spacing" valueMM={spec.motionCentreMM ?? MOTION_CENTRE_MM}
              units={units} min={5} step={5}
              onChange={(motionCentreMM) => set({ motionCentreMM })} />
          )}
          <p className={noteCls}>
            {design.motion
              ? `${design.motion.cannonPins}/${design.motion.minuteTeeth} then `
                + `${design.motion.minutePins}/${design.motion.hourTeeth}, both at `
                + `${L(design.motion.centreDistanceMM)} — 12:1 off the minute arbor.`
              : 'Off — the great wheel carries the minute hand and there is no hour hand.'}
          </p>
        </div>

        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Weight drive</p>
          <PlainInput label="Run" value={spec.runHours} unit="h" min={1} max={200} step={1}
            onChange={(runHours) => set({ runHours })} />
          <NumInput label="Drop" valueMM={spec.fallMM} units={units} min={50}
            onChange={(fallMM) => set({ fallMM })} />
          <NumInput label="Drum Ø" valueMM={spec.drumDia} units={units} min={5}
            onChange={(drumDia) => set({ drumDia })} />
        </div>

        {/* One button standing for the whole readout, in the colour of its WORST
            line — so a fatal warning is visible even with the window shut, which
            is what makes moving the text out of the sidebar safe. */}
        <button
          onClick={() => setClockInfoOpen(!clockInfoOpen)}
          className={`w-full flex items-center justify-center gap-1.5 py-1 rounded border text-label transition-colors ${TONE_BTN[readout.tone]}`}
        >
          <Info size={ICON.sm} />
          {clockInfoOpen ? 'Hide numbers' : summary}
        </button>

        {/* Running the assembled clock, and folding the train to fit a plate.
            Both are questions about the WHOLE clock rather than about any one
            wheel, so they live here rather than on each wheel's properties —
            where they appeared five times over and read as five different
            animations. Only for a clock that EXISTS: there is nothing to stand
            up until it has been added. */}
        {clockEditId && <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Assembly</p>
          <button
            onClick={() => setClockLink(clockArranging ? null : anyClockPathId)}
            disabled={!anyClockPathId}
            className={`w-full py-1.5 rounded text-body text-white disabled:opacity-40 transition-colors ${clockArranging
              ? 'bg-red-500/80 hover:bg-red-500'
              : 'bg-amber-600/80 hover:bg-amber-600'}`}
          >
            {clockArranging ? 'Done arranging' : 'Arrange linkage'}
          </button>
          <button
            onClick={() => setClockAnim(clockRunning ? null : anyClockPathId)}
            disabled={!anyClockPathId}
            className={`w-full py-1.5 rounded text-body text-white disabled:opacity-40 transition-colors ${clockRunning
              ? 'bg-red-500/80 hover:bg-red-500'
              : 'bg-emerald-600/80 hover:bg-emerald-600'}`}
          >
            {clockRunning ? 'Stop clock' : 'Animate whole clock'}
          </button>
        </div>}

        {/* Changing the module or the tooth counts changes every wheel's size,
            so a re-layout is usually what is wanted — but a maker who has
            arranged the parts on the stock should be able to keep that. */}
        {clockEditId && <Check label="Re-lay" checked={reLayout} onChange={setReLayout} />}
        {clockEditId && <p className={noteCls}>
          {reLayout
            ? 'Parts will be laid out afresh on the stock.'
            : 'Parts stay where they are — bigger wheels may overlap.'}
        </p>}
        <button
          onClick={run}
          disabled={busy}
          className="w-full py-1.5 rounded text-body bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
        >
          {busy ? 'Building…' : clockEditId ? 'Update clock' : 'Add clock'}
        </button>
      </div>
    </div>
  )
}
