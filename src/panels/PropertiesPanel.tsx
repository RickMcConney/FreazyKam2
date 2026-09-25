import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Dices } from 'lucide-react'
import { usePathsStore, bakePathsStep, useSelectedPaths, outerGroupOf } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { splitCompoundPath } from '../canvas/nodeUtils'
import { regenerateAffectedMany } from '../cam/regenerate'
import { useCanvasStore } from '../store/canvasStore'
import { parseNumeric, NUMERIC_HINT } from '../components/parseNumeric'
import { useWorkpieceStore, fromMM, toMM } from '../store/workpieceStore'
import { getMultiBBox, placedAngleDeg, type TransformStep } from '../canvas/selectionUtils'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { spirographLoops, SPIRO_RATIO_RANGE, scaleShapeParams, type ShapeParams } from '../shapes/shapeGenerators'
import { loadFont, isFontLoaded, SINGLE_LINE_FONT_FAMILY } from '../shapes/textGenerator'
import { carriedPinion, gearDims, gearHubOf, gearLabel, gearMesh, gearRimW, gearRotationSense, gearSpokeW, pinionDims, pinionLabel, TOOTH_LABEL_SIZE } from '../shapes/gearGenerator'
import { hubGrownWhy } from '../shapes/spokedWheel'
import { camDims } from '../shapes/camGenerator'
import type { EscapementSpec } from '../shapes/escapementGenerator'
import EscapementInfoButton from './EscapementInfoButton'
import { pendulumDims } from '../shapes/pendulumGenerator'
import { trackDims, BRIO } from '../shapes/trackGenerator'
import { BOARD_EDGE_LABEL, BOARD_HANDLE_LABELS, BOARD_HANDLE_HAS_INSET, BOARD_HANDLE_DEFAULTS } from '../shapes/cuttingBoardGenerator'
import { NumericInput } from '../components/NumericInput'
import { UnitLabel, SliderValue } from '../components/UnitColumn'
import FontSelect from '../components/FontSelect'
import ConstraintsSectionBase from './ConstraintsSection'

// Memoised here rather than in its own file: it takes no props, so the only renders it
// needs are its own store subscriptions' — not one per frame of a drag in this panel.
const ConstraintsSection = memo(ConstraintsSectionBase)

const fieldCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-600 rounded px-1.5 py-0.5 text-body text-gray-800 dark:text-neutral-200 font-mono w-0 focus:outline-none focus:border-blue-500'
const labelCls = 'text-gray-600 dark:text-neutral-400 text-label w-5 flex-shrink-0'

function ReadField({ label, value, units }: { label: string; value: string; units?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <span className={fieldCls + ' tabular-nums'}>{value}</span>
      <UnitLabel>{units}</UnitLabel>
    </div>
  )
}

function EditField({
  label,
  valueMM,
  units,
  onChange,
  min = 0.001,
  integer,
}: {
  label: string
  valueMM: number
  units: string
  onChange: (mm: number) => void
  min?: number
  integer?: boolean
}) {
  const display = integer ? valueMM : fromMM(valueMM, units as 'mm' | 'in')
  const step = integer ? 1 : units === 'in' ? 0.0625 : 1

  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <NumericInput
        value={display}
        min={min}
        step={step}
        integer={integer}
        unit={integer ? undefined : units}
        unitCol
        onChange={(v) => onChange(integer ? v : toMM(v, units as 'mm' | 'in'))}
        className={fieldCls}
      />
    </div>
  )
}

// Unitless numeric field (scale/skew ratios, angles) — bypasses EditField's
// mm/inch conversion since these values aren't lengths.
function RawField({ label, value, onChange, suffix, step = 0.01, min, max }: {
  label: string
  value: number
  onChange: (v: number) => void
  suffix?: string
  step?: number
  min?: number
  max?: number
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <NumericInput value={value} min={min} max={max} step={step} unit={suffix} unitCol onChange={onChange} className={fieldCls} />
    </div>
  )
}

// The net transform, as fixed values a user can type into directly instead
// of needing to drag on canvas — dx/dy/angle/sx/sy always shown (0/0/0/1/1
// when absent). kx/ky only appear when the chip actually has shear (rare
// enough that showing it unconditionally would just be clutter), and a
// mirror flip is a separate button (see applyMirrorToChip), not a field.
//
// Each field is read from — and, when reconstructed, written back to — its
// OWN step's stored pivot (cx/cy for rotate, ax/ay for scale/skew), never a
// freshly-computed one. That's what makes the fields independent: editing
// SX only ever changes that scale step's sx, never its anchor, never the
// translate step, never the rotate step — so "dx=100, set it to 105" really
// does just move it 5mm, and doesn't ride along with whatever else changed.
// A pivot is only ever computed fresh (from `defaultPivot`/`defaultSkewPivot`
// — the selection's bbox from just BEFORE this chip started, NOT its
// current/live bbox, which would drift every time dx/dy changes) the first
// time that step kind is introduced; from then on it's whatever got stored.

// One heading per section, so "the thing" and "where it sits" read as two
// groups rather than one long column of fields. Only drawn when there IS a
// shape section — a pen path has one group and needs no label to separate it
// from nothing.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider mt-2 mb-1">
      {children}
    </p>
  )
}

// `baseAngle` is how far the shape ALREADY stands turned — read back out of its
// placement recipe. The field used to be a pure nudge: type 10, it turned 10°
// more, and snapped back to 0, so a shape rotated 37° reported 0° and the one
// number the drawing cannot show had nowhere to be read. Now that a rotation
// spills into `placement` instead of being baked away, the angle is recoverable,
// so the field states it and a typed value is the angle to STAND AT. What it
// hands `onApply` is still the delta, which is what a transform step is.
//
// A path with no parameters has no placement and no way to know: `baseAngle` is
// 0 for it and the field behaves exactly as it always did.
function RotationField({ liveAngle, baseAngle, onApply }: { liveAngle: number | null; baseAngle: number; onApply: (deg: number) => void }) {
  const shown = String(+baseAngle.toFixed(2))
  const [text, setText] = useState(shown)
  // Guard against double-commit: Enter calls commit() then blur() which re-triggers onBlur.
  const committedRef = useRef(false)
  // Follows the shape: after a canvas rotate lands, the field must read the new
  // angle rather than whatever was last typed into it.
  useEffect(() => { setText(shown) }, [shown])
  // WHO A TYPED ANGLE TURNS, frozen while the box is dirty — the same trap
  // NumericInput has, and worse here because the field applies a DELTA. Canvas
  // selection changes on mousedown and the blur that commits arrives after it,
  // by which point this render carries the newly clicked shape's baseAngle and
  // onApply; the resync effect above cannot save it, being a passive effect
  // React runs in a later task. So an angle typed against one shape turned the
  // next one clicked. Untouched box (text === shown) re-arms it.
  const target = useRef({ baseAngle, onApply })
  if (text === shown) target.current = { baseAngle, onApply }

  // `parseNumeric`, never `parseFloat` — this field is hand-rolled rather than a
  // NumericInput (it applies a DELTA and must not fire while a rotation is being typed),
  // which is exactly how it came to be the one angle box that took neither a fraction nor
  // an `=` formula. parseFloat also read '1/2' as 1, i.e. a 1° turn where half a degree
  // was asked for.
  function commit(currentText: string) {
    if (committedRef.current) return
    committedRef.current = true
    const v = parseNumeric(currentText)
    const { baseAngle: from, onApply: apply } = target.current
    if (v !== null && Math.abs(v - from) > 0.0001) apply(v - from)
    setText(shown)
  }

  if (liveAngle !== null) {
    return <ReadField label="∠" value={(baseAngle + liveAngle).toFixed(1)} units="°" />
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>∠</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => { committedRef.current = false; setText(e.target.value) }}
        onFocus={(e) => { committedRef.current = false; e.target.select() }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur() }
          if (e.key === 'Escape') { committedRef.current = true; setText(shown); e.currentTarget.blur() }
          // A nudge resolves whatever is in the box first, so stepping from '=45/2' steps
          // from 22.5 — the same reading NumericInput's stepper takes.
          if (e.key === 'ArrowUp') { e.preventDefault(); setText(String((parseNumeric(e.currentTarget.value) ?? 0) + 1)) }
          if (e.key === 'ArrowDown') { e.preventDefault(); setText(String((parseNumeric(e.currentTarget.value) ?? 0) - 1)) }
        }}
        className={fieldCls}
        title={NUMERIC_HINT}
      />
      <UnitLabel>°</UnitLabel>
    </div>
  )
}

// MEMOISED: the panel around it re-renders on every frame of a canvas drag (it reads the
// live bbox and angle), and this is the part whose size is a gear's worth of fields and
// derived readouts. Its props hold still through a move — see liveShapeParams — so a drag
// costs it nothing; a resize still updates it, since the sizes it shows are changing.
const ShapeParamsEditor = memo(function ShapeParamsEditor({ id, params, units, fromCenter }: { id: string; params: ShapeParams; units: string; fromCenter?: boolean }) {
  const updateShapeParams = usePathsStore((s) => s.updateShapeParams)
  // Subscribed rather than read once, so the escapement's Animate button knows
  // to say Stop. Hooks cannot live inside the switch below.
  const meshAnimPathId = useUIStore((s) => s.meshAnimPathId)
  // Running the assembled clock and folding its linkage used to be offered here,
  // on every wheel — but both are questions about the WHOLE clock, not about the
  // wheel that happens to be selected, so every wheel showed the same pair
  // of buttons and they read as five different animations. They live in
  // ClockPanel now, reached from the clock's own chip. The per-shape "Animate in
  // mesh" below stays: that IS a question about this wheel, against its own
  // lantern or its own anchor.
  // A multi-part shape (a gear) regenerates every path in its group, so every
  // one of their operations is stale — not just this path's. Read the paths back
  // AFTER the edit so a part that just appeared is included.
  const groupIds = () => {
    const st = usePathsStore.getState()
    const self = st.paths.find((p) => p.id === id)
    if (!self || self.shapePart === undefined) return [id]
    return st.paths.filter((p) => p.groupId === self.groupId && p.shapePart !== undefined).map((p) => p.id)
  }
  const update = (newParams: ShapeParams) => { updateShapeParams(id, newParams); regenerateAffectedMany(groupIds()) }
  // A slider fires on every pixel of the drag. The geometry update is cheap and
  // has to be live to be worth dragging, but `regenerateAffected` queues a
  // worker toolpath job per call — so the drag updates `d` only, and the
  // regenerate waits for the release.
  const updateLive = (newParams: ShapeParams) => updateShapeParams(id, newParams)
  const u = units

  // SIZE for the box-shaped params — rectangle, roundrect, inroundrect, maze,
  // board — which all state their extent as w/h. POSITION is deliberately not
  // here: it belongs to the Transform section, for every path, stated once, as
  // the centre. A rectangle used to report the low corner its params happen to
  // store, which is the right anchor only while the shape grows from a corner —
  // set to grow from its middle, its X/Y slid every time its width was typed
  // while the shape stayed put. And it disagreed with the circles and polygons
  // beside it, which have always said CX/CY.
  //
  // A plain function, not a component: a component declared inside another one
  // is a new type on every render, so React remounts it and the field being
  // typed into loses focus.
  const boxSize = <P extends ShapeParams & { x: number; y: number; w: number; h: number }>(
    p: P, set: (patch: Partial<P>) => void,
  ) => (<>
    <EditField label="W" valueMM={p.w} units={u}
      onChange={(w) => set((fromCenter ? { w, x: p.x + (p.w - w) / 2 } : { w }) as Partial<P>)} />
    <EditField label="H" valueMM={p.h} units={u}
      onChange={(h) => set((fromCenter ? { h, y: p.y + (p.h - h) / 2 } : { h }) as Partial<P>)} />
  </>)

  switch (params.type) {
    case 'rectangle':
      return (<>
        {boxSize(params, (patch) => update({ ...params, ...patch }))}
      </>)
    case 'roundrect':
    case 'inroundrect':
      return (<>
        {boxSize(params, (patch) => update({ ...params, ...patch }))}
        <EditField label="R" valueMM={params.r} units={u} onChange={(r) => update({ ...params, r })} min={0} />
      </>)
    case 'circle':
      return (<>
        <EditField label="Ø" valueMM={params.radius * 2} units={u} onChange={(dia) => update({ ...params, radius: dia / 2 })} />
      </>)
    case 'ellipse':
      return (<>
        {/* Width and height, not radii — the Draw panel creates an ellipse by its W/H, and
            a 50 mm-wide ellipse must not come back as 25. */}
        <EditField label="W" valueMM={params.rx * 2} units={u} onChange={(w) => update({ ...params, rx: w / 2 })} />
        <EditField label="H" valueMM={params.ry * 2} units={u} onChange={(h) => update({ ...params, ry: h / 2 })} />
      </>)
    case 'shield':
      return (<>
        <EditField label="W"  valueMM={params.w}  units={u} onChange={(w)  => update({ ...params, w })} />
        <EditField label="H"  valueMM={params.h}  units={u} onChange={(h)  => update({ ...params, h })} />
      </>)
    case 'spirograph':
      return (<>
        <EditField label="R"     valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
        {/* Loops and pen position both span the grid — a slider reads the pattern
            far better than typing it, and both the loop count and p = loops−1
            (centre-filling) are places you find by dragging. The ratio is a whole
            number, so every notch on the loops slider is a different rosette. */}
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Loops</span>
          <input
            type="range" min={SPIRO_RATIO_RANGE.min} max={SPIRO_RATIO_RANGE.max} step={1}
            value={spirographLoops(params.ratio)}
            onChange={(e) => {
              const ratio = spirographLoops(parseFloat(e.target.value))
              updateLive({ ...params, ratio, p: Math.min(params.p, ratio) })
            }}
            onPointerUp={() => regenerateAffectedMany(groupIds())}
            onKeyUp={() => regenerateAffectedMany(groupIds())}
            className="flex-1 w-0 accent-blue-500"
          />
          <SliderValue>{spirographLoops(params.ratio)}</SliderValue>
        </div>
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>p</span>
          <input
            type="range" min={0} max={spirographLoops(params.ratio)} step={0.01} value={params.p}
            onChange={(e) => updateLive({ ...params, p: parseFloat(e.target.value) })}
            onPointerUp={() => regenerateAffectedMany(groupIds())}
            onKeyUp={() => regenerateAffectedMany(groupIds())}
            className="flex-1 w-0 accent-blue-500"
          />
          <SliderValue>{params.p.toFixed(2)}</SliderValue>
        </div>
      </>)
    case 'maze':
      return (<>
        {boxSize(params, (patch) => update({ ...params, ...patch }))}
        {/* Corridor spacing, not corridor count — the wall left standing is
            spacing − cutter diameter, so this is the field set from the bit. */}
        <EditField label="Sp" valueMM={params.spacing} units={u} onChange={(spacing) => update({ ...params, spacing })} />
        <EditField label="Cnr" valueMM={params.corner} units={u} min={0} onChange={(corner) => update({ ...params, corner })} />
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Sd</span>
          <NumericInput value={params.seed} min={1} max={999999} step={1} integer
            onChange={(seed) => update({ ...params, seed: Math.max(1, Math.round(seed)) })}
            className={fieldCls} />
          <button
            onClick={() => update({ ...params, seed: 1 + Math.floor(Math.random() * 999999) })}
            title="New maze"
            className="p-1 rounded text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200 hover:bg-gray-200/70 dark:hover:bg-neutral-700 flex-shrink-0"
          >
            <Dices size={14} />
          </button>
        </div>
        {/* Braiding reopens dead ends into loops — a drag, like the spirograph
            pen, because it is a look you find rather than a number you know. */}
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Lp</span>
          <input
            type="range" min={0} max={1} step={0.05} value={params.loops}
            onChange={(e) => updateLive({ ...params, loops: parseFloat(e.target.value) })}
            onPointerUp={() => regenerateAffectedMany(groupIds())}
            onKeyUp={() => regenerateAffectedMany(groupIds())}
            className="flex-1 w-0 accent-blue-500"
          />
          <SliderValue>{Math.round(params.loops * 100)}%</SliderValue>
        </div>
      </>)
    case 'board': {
      const edgeLabel = BOARD_EDGE_LABEL[params.shape]
      const handleLabels = BOARD_HANDLE_LABELS[params.handle]
      return (<>
        {boxSize(params, (patch) => update({ ...params, ...patch }))}
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Sh</span>
          <select value={params.shape} onChange={(e) => update({ ...params, shape: e.target.value as typeof params.shape })}
            className={fieldCls + ' cursor-pointer'}>
            <option value="rect">Rectangle</option>
            <option value="oval">Oval</option>
            <option value="barrel">Barrel</option>
          </select>
        </div>
        {edgeLabel && <EditField label={edgeLabel === 'Bow' ? 'Bow' : 'Cnr'} valueMM={params.corner} units={u} min={0} onChange={(corner) => update({ ...params, corner })} />}
        {edgeLabel && <span />}
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Hdl</span>
          <select
            value={params.handle}
            onChange={(e) => {
              const handle = e.target.value as typeof params.handle
              // Reseed the sizes — see BOARD_HANDLE_DEFAULTS; a paddle's neck
              // read as a slot is not a handle at all.
              update({ ...params, handle, ...BOARD_HANDLE_DEFAULTS[handle] })
            }}
            className={fieldCls + ' cursor-pointer'}>
            <option value="none">None</option>
            <option value="paddle">Paddle</option>
            <option value="grips">Side slots</option>
            <option value="slot">End slot</option>
          </select>
        </div>
        {handleLabels && (<>
          <EditField label="HW" valueMM={params.handleW} units={u} onChange={(handleW) => update({ ...params, handleW })} />
          <EditField label="HL" valueMM={params.handleL} units={u} onChange={(handleL) => update({ ...params, handleL })} />
        </>)}
        {BOARD_HANDLE_HAS_INSET[params.handle] && (<>
          <EditField label="Gap" valueMM={params.handleInset} units={u} onChange={(handleInset) => update({ ...params, handleInset })} />
          <span />
        </>)}
        {!BOARD_HANDLE_HAS_INSET[params.handle] && (
          <label className="flex items-center gap-1.5 cursor-pointer">
            <span className={labelCls}>Hole</span>
            <input type="checkbox" checked={params.hole} onChange={(e) => update({ ...params, hole: e.target.checked })}
              className="accent-blue-500 w-3.5 h-3.5" />
          </label>
        )}
        {!BOARD_HANDLE_HAS_INSET[params.handle] && params.hole
          ? <EditField label="Ø" valueMM={params.holeDia} units={u} onChange={(holeDia) => update({ ...params, holeDia })} />
          : <span />}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <span className={labelCls}>Grv</span>
          <input type="checkbox" checked={params.groove} onChange={(e) => update({ ...params, groove: e.target.checked })}
            className="accent-blue-500 w-3.5 h-3.5" />
        </label>
        {params.groove
          ? <EditField label="In" valueMM={params.grooveInset} units={u} onChange={(grooveInset) => update({ ...params, grooveInset })} />
          : <span />}
      </>)
    }
    case 'gear': {
      const cyc = params.toothProfile === 'cycloidal'
        ? { mateTeeth: params.mateTeeth, pinDia: params.pinDia } : undefined
      const d = gearDims(params.module, params.teeth, params.pressureAngle, params.backlash, cyc)
      // The pinion this wheel CARRIES, if any — its holes are a second floor
      // under the hub, so the readout must ask for it or it reports a hub the
      // generator has already grown past.
      const carried = carriedPinion(params)
      const hub = gearHubOf(params)
      const lab = gearLabel(params)
      const pin = pinionDims(params)
      const pinLab = pinionLabel(params)
      const mesh = gearMesh(params)
      const running = meshAnimPathId === id
      // The cycloidal root is set by the pin alone, so it is normally SHALLOWER
      // than the ISO dedendum, not deeper — worth saying either way it differs.
      const rootByPin = !!cyc && Math.abs(d.rootDia - params.module * (params.teeth - 2.5)) > 0.01
      const relief = Math.round(Math.max(0, Math.min(1, params.backRelief ?? 0)) * 100)
      // The field is the wheel's ROTATION, which is what a maker knows and what
      // decides which way up it goes on the arbor. The acting FLANK is the
      // opposite one where the pins drive, so the two are not interchangeable and
      // one conversion serves both directions.
      const driven = !!params.drivenByPins
      const turnsCW = gearRotationSense(params) === -1
      const senseFor = (cw: boolean): 1 | -1 => (cw ? -1 : 1) * (driven ? -1 : 1) as 1 | -1
      const N = (mm: number) => fromMM(mm, u as 'mm' | 'in').toFixed(2)
      // Regenerating a gear REPLACES its paths, so an edit made before the
      // single-stroke face has loaded would drop the number the gear already
      // carries (generateGearParts cannot emit what it cannot set). Wait for the
      // font — a no-op once it is cached, which is the same thing the text shape
      // does for the same reason.
      const updateGear = (p: ShapeParams) => {
        if (p.type === 'gear' && p.toothLabel) loadFont(SINGLE_LINE_FONT_FAMILY).then(() => update(p))
        else update(p)
      }
      return (<>
        <EditField label="Mod" valueMM={params.module} units={u} min={0.05} onChange={(module) => updateGear({ ...params, module })} />
        <EditField label="N"   valueMM={params.teeth} units="" min={4} integer onChange={(teeth) => updateGear({ ...params, teeth: Math.max(4, Math.round(teeth)) })} />
        {/* Involute or cycloidal. A cycloidal face is cut for ONE mate, so the
            pinion is a parameter of the wheel; pressure angle has no meaning in a
            cycloidal mesh and its field goes away with the profile. */}
        <label className="flex items-center gap-1.5 col-span-2">
          <span className={labelCls}>Prf</span>
          <select value={params.toothProfile ?? 'involute'} className={fieldCls}
            onChange={(e) => updateGear({ ...params, toothProfile: e.target.value as 'involute' | 'cycloidal' })}>
            <option value="involute">Involute</option>
            <option value="cycloidal">Cycloidal (clock)</option>
          </select>
        </label>
        {/* Cycloidal takes the lantern it is cut for — pin count and pin diameter
            — in place of a pressure angle, which a cycloidal mesh does not have. */}
        {cyc
          ? <EditField label="Pin" valueMM={params.mateTeeth} units="" min={2} integer onChange={(mateTeeth) => updateGear({ ...params, mateTeeth: Math.max(2, Math.round(mateTeeth)) })} />
          : <RawField  label="PA"  value={params.pressureAngle} min={5} max={35} step={0.5} suffix="°" onChange={(pressureAngle) => updateGear({ ...params, pressureAngle })} />}
        {cyc && <EditField label="PØ" valueMM={params.pinDia} units={u} min={0.1} onChange={(pinDia) => updateGear({ ...params, pinDia })} />}
        {/* The back of each tooth, cut away as one curve from the tip down to the
            root: a clock wheel turns one way, so that flank never touches a pin and
            is only in the way of the next one arriving. `Runs` is which way, and it
            is the risk — relieve the ACTING flank and the wheel still looks and
            turns like a clock wheel with nothing left to drive with. */}
        {cyc && <RawField label="Back" value={relief} min={0} max={100} step={10} suffix="%"
          onChange={(v) => updateGear({ ...params, backRelief: Math.max(0, Math.min(1, v / 100)) })} />}
        {/* ALWAYS SHOWN, not only under back relief. It was gated on relief on the
            reasoning that direction is invisible in the cut without it — true of
            the TEETH, and it stopped being the whole story once `gearPose` began
            turning the wheel the way this says and settling the mate on the flank
            it drives. Both are visible at 0% relief, so the field that sets them
            has to be reachable there. */}
        {cyc && <label className="flex items-center gap-1.5">
          <span className={labelCls}>Runs</span>
          <select value={turnsCW ? 'cw' : 'ccw'} className={fieldCls}
            onChange={(e) => updateGear({ ...params, actingSense: senseFor(e.target.value === 'cw') })}>
            <option value="cw">CW</option>
            <option value="ccw">CCW</option>
          </select>
        </label>}
        {/* Whether the pins push this wheel or it pushes them. It cuts nothing —
            it says which way to read the teeth, and the two motion-work wheels of
            a clock are the only ones in it that lean the other way. */}
        {cyc && relief > 0 && <label className="flex items-center gap-1.5 cursor-pointer" title="The pins drive this wheel — a motion work">
          <span className={labelCls}>Driven</span>
          <input type="checkbox" checked={driven}
            onChange={(e) => updateGear({ ...params, drivenByPins: e.target.checked, actingSense: (params.actingSense === 1 ? -1 : 1) })}
            className="accent-blue-500 w-3.5 h-3.5" />
        </label>}
        {/* The same field, and it means two different things. On a cycloidal
            wheel the mate SHAPES the teeth — the face is conjugate to one
            particular lantern. On an involute gear it changes nothing that gets
            cut; it only says what to run the preview against, which is the one
            way to see whether the pair the gear is for actually meshes. */}
        {!cyc && <EditField label="Mate" valueMM={params.mateTeeth} units="" min={4} integer onChange={(mateTeeth) => updateGear({ ...params, mateTeeth: Math.max(4, Math.round(mateTeeth)) })} />}
        {/* Spelt out rather than abbreviated: a tick called "Pnn" would be the "Ltn"
            mistake again. */}
        {cyc && <label className="flex items-center gap-1.5 col-span-2 cursor-pointer">
          <input type="checkbox" checked={!!params.emitPinion}
            onChange={(e) => updateGear({ ...params, emitPinion: e.target.checked })}
            className="accent-blue-500 w-3.5 h-3.5" />
          <span className="text-label text-gray-600 dark:text-neutral-400">Emit the lantern pinion</span>
        </label>}
        <EditField label="Ø"   valueMM={params.bore} units={u} min={0} onChange={(bore) => updateGear({ ...params, bore })} />
        <EditField label="Hub" valueMM={params.hubDia} units={u} min={0} onChange={(hubDia) => updateGear({ ...params, hubDia })} />
        <EditField label="Spk" valueMM={params.spokes} units="" min={0} integer onChange={(spokes) => updateGear({ ...params, spokes: Math.max(0, Math.round(spokes)) })} />
        {/* The web's two thicknesses, in MILLIMETRES: how much wood is left
            holding the rim on is a question about the stock and the cutter, not
            about the tooth size. Each shows its RESOLVED figure, so a gear that
            has never been dialled in reads 2.5·module and goes on following the
            module as it is stepped; 0 lets go of it again. */}
        <EditField label="SpkW" valueMM={gearSpokeW(params.module, params.spokeWidth)} units={u} min={0}
          onChange={(v) => updateGear({ ...params, spokeWidth: v > 0 ? v : undefined })} />
        <EditField label="Rim"  valueMM={gearRimW(params.module, params.rimWidth)} units={u} min={0}
          onChange={(v) => updateGear({ ...params, rimWidth: v > 0 ? v : undefined })} />
        <EditField label="Lash" valueMM={params.backlash} units={u} min={0} onChange={(backlash) => updateGear({ ...params, backlash })} />
        {/* Engraved, not cut: its own path, deleted or given an engrave op on
            its own. */}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <span className={labelCls}>#</span>
          <input type="checkbox" checked={!!params.toothLabel}
            onChange={(e) => updateGear({ ...params, toothLabel: e.target.checked })}
            className="accent-blue-500 w-3.5 h-3.5" />
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <span className={labelCls}>P○</span>
          <input type="checkbox" checked={params.pitchCircle}
            onChange={(e) => updateGear({ ...params, pitchCircle: e.target.checked })}
            className="accent-blue-500 w-3.5 h-3.5" />
        </label>
        {/* Base Ø is m·z·cos α — derived from the three above it, so it is a
            readout, not a field. */}
        <div className="col-span-2 text-label text-gray-600 dark:text-neutral-400 leading-tight">
          {cyc ? <>Pitch {N(d.pitchDia)} · Describing {N(d.describingDia)}</> : <>Pitch {N(d.pitchDia)} · Base {N(d.baseDia)}</>}
          <br />
          OD {fromMM(d.outsideDia, u as 'mm' | 'in').toFixed(2)} · Root {fromMM(d.rootDia, u as 'mm' | 'in').toFixed(2)} {u}
          <br />
          Meshes at {fromMM(d.pitchDia / 2, u as 'mm' | 'in').toFixed(2)} + partner pitch radius
          <br />
          Tooth {fromMM(d.toothThickness, u as 'mm' | 'in').toFixed(2)} at pitch
          {hub.grown && <><br /><span className="text-blue-400">Hub grown to {fromMM(hub.dia, u as 'mm' | 'in').toFixed(2)} {hubGrownWhy(hub, params.spokes)}.</span></>}
          {params.spokes >= 2 && !hub.spoked && <><br /><span className="text-yellow-500">
            {hub.maxSpokes >= 2 ? `Max ${hub.maxSpokes} spokes here — cut solid.` : 'No room for spokes — cut solid.'}
          </span></>}
          {params.toothLabel && lab && <><br />Engraves &ldquo;{lab.text}&rdquo;{lab.sizeMM < TOOTH_LABEL_SIZE - 0.05 && <span className="text-blue-400"> at {fromMM(lab.sizeMM, u as 'mm' | 'in').toFixed(2)} — all the spoke takes</span>}</>}
          {params.toothLabel && !lab && isFontLoaded(SINGLE_LINE_FONT_FAMILY) && <><br /><span className="text-yellow-500">No room beside the bore for a legible marking — none engraved.</span></>}
          {params.pitchCircle && <><br /><span className="text-yellow-500">Pitch circle is a reference — delete before cutting.</span></>}
          {d.pointed && <><br /><span className="text-yellow-500">Teeth pointed — OD reduced.</span></>}
          {!cyc && d.undercut && <><br /><span className="text-gray-600 dark:text-neutral-400">Undercut — roots hobbed, flank waisted below the base circle.</span></>}
          {cyc && d.pinTooFat && <><br /><span className="text-red-400">
            Ø{N(params.pinDia)} pins take the whole {N(d.circularPitch)} pitch — no tooth left to drive with. Thinner pins, or a bigger module.
          </span></>}
          {rootByPin && <><br /><span className="text-blue-400">Root cut to {N(d.rootDia)} — just clears the pins.</span></>}
          {cyc && <><br />Cut for a {params.mateTeeth}-pin lantern at Ø{N(params.pinDia)}.</>}
          {cyc && relief > 0 && <><br />Back of each tooth cut away
            {relief >= 100 ? ' to the middle of the tip' : ` by ${relief}% of the tip`} — turns
            {turnsCW ? ' clockwise' : ' anticlockwise'} only.
            {driven && ' Its pins DRIVE it, so the teeth lean the opposite way from a wheel that drives.'}</>}
          {/* The pinion on this wheel's OWN arbor, which it carries: the wheel is
              one of that lantern's two cheeks, so only one loose cheek is cut. */}
          {carried && <>
            <br />Carries {carried.pins} pins on Ø{N(carried.pinCircleDia)} through its hub — this wheel is
            one cheek of that pinion, so cut ONE loose cheek for the far ends.
            {carried.gap < 1 && <><br /><span className="text-yellow-500">
              Only {N(Math.max(0, carried.gap))} between those holes — fewer or thinner pins.
            </span></>}
            {carried.pinCircleDia / 2 - carried.pinDia / 2 < params.bore / 2 + 1 && <><br /><span className="text-red-400">
              Those holes break into the Ø{N(params.bore)} arbor hole — a bigger pin circle, or a smaller bore.
            </span></>}
          </>}
          {cyc && params.emitPinion && pin && <>
            <br />Pinion cheek {N(pin.cheekDia)}, pins on {N(pin.pinCircleDia)} — cut TWO, the wheel runs between them.
            <br />Arbors {N(pin.centreDistance)} apart = {N(d.pitchDia / 2)} wheel pitch radius + {N(pin.pinCircleDia / 2)} arbor to pin centre. Drawn clear, not at that spacing.
            {params.toothLabel && pinLab && <><br />Cheek engraves &ldquo;{pinLab.text}&rdquo; — add to the wheel&apos;s.</>}
            {pin.pinGap < 1 && <><br /><span className="text-yellow-500">
              Only {N(Math.max(0, pin.pinGap))} between pin holes — fewer or thinner pins.
            </span></>}
          </>}
          {/* What the Animate button will show, and the one number it makes
              visible: the play the pair has before the drive takes up. */}
          <br />Runs {mesh.ratio.toFixed(3)}:1 against {cyc
            ? `its ${mesh.mateTeeth}-pin lantern`
            : `a ${mesh.mateTeeth}-tooth gear`} at {N(mesh.centreDistance)} centres
          <br />Play at the mesh {N(mesh.playAtPitch)}

        </div>
        {/* A gear is drawn alone and its lantern is drawn clear of it, so the one
            thing the drawing cannot show is whether they run together. This puts
            the mate at the real centre distance and turns the pair. A preview
            only — nothing is written. */}
        <button
          type="button"
          onClick={() => useUIStore.getState().setMeshAnim(running ? null : id)}
          className={`col-span-2 rounded px-2 py-1 text-label ${running
            ? 'bg-red-500/80 hover:bg-red-500 text-white'
            : 'bg-blue-500/80 hover:bg-blue-500 text-white'}`}
        >
          {running ? 'Stop' : 'Animate in mesh'}
        </button>
      </>)
    }
    case 'escapement': {
      const dead = params.escType === 'deadbeat'
      const running = meshAnimPathId === id
      return (<>
        <label className="flex items-center gap-1.5 col-span-2">
          <span className={labelCls}>Type</span>
          <select value={params.escType} className={fieldCls}
            onChange={(ev) => update({ ...params, escType: ev.target.value as 'deadbeat' | 'recoil' })}>
            <option value="deadbeat">Deadbeat (Graham)</option>
            <option value="recoil">Recoil (anchor)</option>
          </select>
        </label>
        <EditField label="N"    valueMM={params.teeth} units="" min={6} integer onChange={(teeth) => update({ ...params, teeth: Math.max(6, Math.round(teeth)) })} />
        <EditField label="Wh Ø" valueMM={params.wheelDia} units={u} min={4} onChange={(wheelDia) => update({ ...params, wheelDia })} />
        <EditField label="Th H" valueMM={params.toothDepth} units={u} min={0.5} onChange={(toothDepth) => update({ ...params, toothDepth })} />
        {/* Drop is at the WHEEL, lift at the ANCHOR. */}
        <RawField label="Drop" value={params.drop} min={0.2} max={10} step={0.25} suffix="°" onChange={(drop) => update({ ...params, drop })} />
        <RawField label="Lift" value={params.lift} min={0.5} max={12} step={0.25} suffix="°" onChange={(lift) => update({ ...params, lift })} />
        {dead
          ? <RawField label="Lock" value={params.lock} min={0} max={10} step={0.25} suffix="°" onChange={(lock) => update({ ...params, lock })} />
          : <RawField label="Rcl"  value={params.recoilArc} min={0.5} max={20} step={0.5} suffix="°" onChange={(recoilArc) => update({ ...params, recoilArc })} />}
        {dead && <RawField label="Draw" value={params.draw} min={0} max={10} step={0.5} suffix="°" onChange={(draw) => update({ ...params, draw })} />}
        <EditField label="ArmW" valueMM={params.armWidth} units={u} min={1} onChange={(armWidth) => update({ ...params, armWidth })} />
        <EditField label="Ø"    valueMM={params.bore} units={u} min={0} onChange={(bore) => update({ ...params, bore })} />
        <EditField label="Hub"  valueMM={params.hubDia} units={u} min={0} onChange={(hubDia) => update({ ...params, hubDia })} />
        <EditField label="Spk"  valueMM={params.spokes} units="" min={0} integer onChange={(spokes) => update({ ...params, spokes: Math.max(0, Math.round(spokes)) })} />
        <EditField label="Arb"  valueMM={params.anchorBore} units={u} min={0} onChange={(anchorBore) => update({ ...params, anchorBore })} />
        {/* Geometry, not a view option: the teeth lean the way the wheel runs. */}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <span className={labelCls}>CW</span>
          <input type="checkbox" checked={params.clockwise}
            onChange={(ev) => update({ ...params, clockwise: ev.target.checked })}
            className="accent-blue-500 w-3.5 h-3.5" />
        </label>
        {/* The readout used to sit here, a dozen lines of numbers in the
            smallest type the app has, wrapped under the very controls being
            clicked. It is a window now — see EscapementInfoPanel — and this
            button carries its status so nothing fatal can hide in it. */}
        <EscapementInfoButton spec={params as unknown as EscapementSpec} />
        {/* The parts are drawn clear of each other, so the one thing the drawing
            cannot show is whether they bind. This puts them at the real centre
            distance and runs them. A preview only — nothing is written. */}
        <button
          type="button"
          onClick={() => useUIStore.getState().setMeshAnim(running ? null : id)}
          className={`col-span-2 rounded px-2 py-1 text-label ${running
            ? 'bg-red-500/80 hover:bg-red-500 text-white'
            : 'bg-blue-500/80 hover:bg-blue-500 text-white'}`}
        >
          {running ? 'Stop' : 'Animate in mesh'}
        </button>
      </>)
    }
    case 'pendulum': {
      const dm = pendulumDims(params)
      const L = (mm: number) => fromMM(mm, u as 'mm' | 'in').toFixed(2)
      return (<>
        {/* CX/CY is the SUSPENSION POINT, not the middle of the drawing — a
            pendulum is placed by where it hangs from. */}
        <EditField label="Len"   valueMM={params.length} units={u} min={1} onChange={(length) => update({ ...params, length })} />
        <EditField label="Rod W" valueMM={params.rodWidth} units={u} min={0.5} onChange={(rodWidth) => update({ ...params, rodWidth })} />
        <EditField label="Bob W" valueMM={params.bobRx * 2} units={u} min={1} onChange={(w) => update({ ...params, bobRx: w / 2 })} />
        <EditField label="Bob H" valueMM={params.bobRy * 2} units={u} min={1} onChange={(h) => update({ ...params, bobRy: h / 2 })} />
        <EditField label="Hole"  valueMM={params.bore} units={u} min={0} onChange={(bore) => update({ ...params, bore })} />
        <div className="col-span-2 text-label text-gray-600 dark:text-neutral-400 leading-snug">
          Beats {dm.beatSeconds.toFixed(4)} s · period {dm.periodSeconds.toFixed(4)} s
          <br />
          Rod {L(dm.rodLength)} {u} overall · Len is the hole to the BOB CENTRE
          <br />
          A real rod runs a little fast — regulate by raising the bob.
          {dm.boreTooBig && <><br /><span className="text-yellow-500">Hole clamped to leave a shoulder on the rod.</span></>}
          {dm.bobTooSmall && <><br /><span className="text-yellow-500">Bob is no wider than the rod.</span></>}
        </div>
      </>)
    }
    case 'cam': {
      const dm = camDims(params)
      const N = (mm: number) => fromMM(mm, u as 'mm' | 'in').toFixed(2)
      return (<>
        <EditField label="Base" valueMM={params.baseDia} units={u} min={1} onChange={(baseDia) => update({ ...params, baseDia })} />
        <EditField label="Rise" valueMM={params.riseMM} units={u} min={0.1} onChange={(riseMM) => update({ ...params, riseMM })} />
        <RawField  label="Swp"  value={params.sweepDeg} min={5} max={360} step={5} suffix="°" onChange={(sweepDeg) => update({ ...params, sweepDeg })} />
        <EditField label="Ø"    valueMM={params.boreDia} units={u} min={0} onChange={(boreDia) => update({ ...params, boreDia })} />
        <EditField label="Lvr"  valueMM={params.handleLength} units={u} min={1} onChange={(handleLength) => update({ ...params, handleLength })} />
        <EditField label="LvrW" valueMM={params.handleWidth} units={u} min={0.5} onChange={(handleWidth) => update({ ...params, handleWidth })} />
        {/* Rise is per REVOLUTION — the spiral's slope. What it lifts is that over
            its own sweep, which is the number worth reading back. */}
        <div className="col-span-2 text-label text-gray-600 dark:text-neutral-400 leading-tight">
          Stroke {N(dm.usableStroke)} over {params.sweepDeg}° · {N(dm.liftPerDeg)} {u}/°
          <br />
          Base {N(dm.baseDia)} → crest {N(dm.maxDia)}
          <br />
          Pressure angle {dm.pressureAngleDeg.toFixed(1)}° base / {dm.pressureAngleAtCrestDeg.toFixed(1)}° crest
          {dm.wontHold && <><br /><span className="text-yellow-500">
            Friction may not hold {dm.pressureAngleDeg.toFixed(1)}° — bigger base, or less rise.
          </span></>}
          {dm.handleTooShort && <><br /><span className="text-yellow-500">Lever inside the crest — no leverage.</span></>}
        </div>
      </>)
    }
    case 'track': {
      const dm = trackDims(params)
      const N = (mm: number) => fromMM(mm, u as 'mm' | 'in').toFixed(2)
      const sel = fieldCls + ' cursor-pointer'
      return (<>
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Kind</span>
          <select value={params.kind} className={sel}
            onChange={(e) => update({ ...params, kind: e.target.value as typeof params.kind })}>
            <option value="straight">Straight</option>
            <option value="curve">Curve</option>
            <option value="turnout">Turnout</option>
          </select>
        </div>
        {params.kind !== 'curve' &&
          <EditField label="Len" valueMM={params.length} units={u} min={20} onChange={(length) => update({ ...params, length })} />}
        {params.kind !== 'straight' &&
          <EditField label="R" valueMM={params.radius} units={u} min={params.width / 2 + 1} onChange={(radius) => update({ ...params, radius })} />}
        {params.kind !== 'straight' &&
          <RawField label="Arc" value={params.sweepDeg} min={1} max={350} step={5} suffix="°" onChange={(sweepDeg) => update({ ...params, sweepDeg })} />}
        {params.kind === 'straight' && <span />}
        {params.kind === 'turnout' && (<>
          <div className="col-span-2 flex items-center gap-1.5">
            <span className={labelCls}>Hand</span>
            {/* Not a mirror — a mirrored path drops its params and stops being
                a turnout, so which way it goes has to be part of the recipe. */}
            <select value={params.hand} className={sel}
              onChange={(e) => update({ ...params, hand: e.target.value as typeof params.hand })}>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </div>
          <EditField label="Crtch" valueMM={params.crotch} units={u} min={0} onChange={(crotch) => update({ ...params, crotch })} />
          <span />
        </>)}
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>{params.kind === 'turnout' ? 'Toe' : 'End A'}</span>
          <select value={params.endA} className={sel}
            onChange={(e) => update({ ...params, endA: e.target.value as typeof params.endA })}>
            <option value="female">Socket</option>
            <option value="male">Peg</option>
            <option value="plain">Square</option>
          </select>
        </div>
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>{params.kind === 'turnout' ? 'Main' : 'End B'}</span>
          <select value={params.endB} className={sel}
            onChange={(e) => update({ ...params, endB: e.target.value as typeof params.endB })}>
            <option value="male">Peg</option>
            <option value="female">Socket</option>
            <option value="plain">Square</option>
          </select>
        </div>
        {params.kind === 'turnout' &&
          <div className="col-span-2 flex items-center gap-1.5">
            <span className={labelCls}>Branch</span>
            <select value={params.endC} className={sel}
              onChange={(e) => update({ ...params, endC: e.target.value as typeof params.endC })}>
              <option value="male">Peg</option>
              <option value="female">Socket</option>
              <option value="plain">Square</option>
            </select>
          </div>}
        <EditField label="W"    valueMM={params.width} units={u} min={10} onChange={(width) => update({ ...params, width })} />
        <EditField label="Gau"  valueMM={params.gauge} units={u} min={1} onChange={(gauge) => update({ ...params, gauge })} />
        <EditField label="Peg"  valueMM={params.pegDia} units={u} min={1} onChange={(pegDia) => update({ ...params, pegDia })} />
        <EditField label="NckW" valueMM={params.neckW} units={u} min={0.5} onChange={(neckW) => update({ ...params, neckW })} />
        <EditField label="NckL" valueMM={params.neckL} units={u} min={0.5} onChange={(neckL) => update({ ...params, neckL })} />
        {/* The socket is the peg plus this one slack — see trackGenerator.ts.
            Editing it moves the hole and the throat together, so the joint can
            never be left half-adjusted. */}
        <EditField label="Clr" valueMM={params.clearance} units={u} min={0.05} onChange={(clearance) => update({ ...params, clearance })} />
        {/* Sleeper marks — the one cosmetic thing on a track, and so the one
            thing on it that may be turned off. A piece saved before they
            existed has no pitch, so ticking them on seeds one. */}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <span className={labelCls}>Trd</span>
          <input type="checkbox" checked={!!params.treads}
            onChange={(e) => update({
              ...params,
              treads: e.target.checked,
              treadPitch: params.treadPitch ?? BRIO.treadPitch,
            })}
            className="accent-blue-500 w-3.5 h-3.5" />
        </label>
        {params.treads
          ? <EditField label="Ptch" valueMM={params.treadPitch} units={u} min={1} onChange={(treadPitch) => update({ ...params, treadPitch })} />
          : <span />}

        <div className="col-span-2 text-label text-gray-600 dark:text-neutral-400 leading-tight">
          {params.kind === 'curve'
            ? <>Chord {N(dm.pitch)} · inner {N(dm.innerRadius)} / outer {N(dm.outerRadius)}</>
            : <>Pitch {N(dm.pitch)} · {N(dm.overall)} overall</>}
          <br />
          {params.kind === 'curve' && <>{dm.closesCircle
            ? <>{Math.round(dm.perCircle)} make a circle</>
            : <>{dm.perCircle.toFixed(2)} to a circle — does not close</>}<br /></>}
          {params.kind === 'turnout' && <>
            Frog {N(dm.frogDist)} from the toe · branch steps {N(dm.divergeOffset)} aside
            <br />
          </>}
          Socket Ø {N(dm.socketDia)} · throat {N(dm.throatW)} × {N(dm.throatL)}
          <br />
          Peg reaches {N(dm.pegReach)} into a {N(dm.socketDepth)} socket
          <br />
          Grooves {N(BRIO.grooveW)} × {BRIO.grooveDepth} deep — centrelines, {N(dm.railMargin)} {u} of rail outside
          {params.treads && <><br />{dm.treadCount} treads at {N(dm.treadSpacing)} {u}</>}
          {dm.grooveOffTrack && <><br /><span className="text-yellow-500">Grooves run off the edge of the track.</span></>}
          {dm.socketBreachesGroove && <><br /><span className="text-yellow-500">
            Socket breaks into a groove — {N(dm.spineMargin)} {u} of spine left.
          </span></>}
          {dm.socketsTooDeep && <><br /><span className="text-yellow-500">Sockets are deeper than the piece is long.</span></>}
          {dm.pegTooThin && <><br /><span className="text-yellow-500">Neck is as wide as the head — no shoulder.</span></>}
          {dm.treadsCrowded && <><br /><span className="text-yellow-500">
            Treads {N(dm.treadSpacing)} {u} apart are closer than the flange slot — a hatch, not sleepers.
          </span></>}
          {dm.frogPastEnd && <><br /><span className="text-yellow-500">
            Main leg ends inside the frog — it needs {N(dm.frogDist)}.
          </span></>}
          {dm.frogPastSweep && <><br /><span className="text-yellow-500">
            Branch stops before the frog at {dm.frogDeg.toFixed(1)}° — the routes never separate.
          </span></>}
          {dm.heelsFoul && <><br /><span className="text-yellow-500">
            Branch is only {N(dm.divergeOffset)} aside — the two heels are in each other's stock.
          </span></>}
        </div>
      </>)
    }
    case 'polygon':
      return (<>
        <EditField label="R" valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
        <EditField label="N" valueMM={params.sides} units="" min={3} integer onChange={(sides) => update({ ...params, sides: Math.max(3, Math.round(sides)) })} />
      </>)
    case 'star':
      return (<>
        <EditField label="OR" valueMM={params.outerRadius} units={u} onChange={(outerRadius) => update({ ...params, outerRadius })} />
        <EditField label="IR" valueMM={params.innerRadius} units={u} onChange={(innerRadius) => update({ ...params, innerRadius })} />
        <EditField label="N" valueMM={params.points} units="" min={3} integer onChange={(points) => update({ ...params, points: Math.max(3, Math.round(points)) })} />
      </>)
    case 'heart':
      return (<>
        <EditField label="R" valueMM={params.curveRadius} units={u} onChange={(curveRadius) => update({ ...params, curveRadius })} />
        <EditField label="Ang" valueMM={params.angle} units="" integer min={1} onChange={(angle) => update({ ...params, angle: Math.min(179, Math.max(1, Math.round(angle))) })} />
      </>)
    case 'slot':
      return (<>
        <EditField label="Len" valueMM={params.length} units={u} onChange={(length) => update({ ...params, length: Math.max(length, params.width) })} />
        <EditField label="W"   valueMM={params.width}  units={u} onChange={(width)  => update({ ...params, width: Math.min(width, params.length) })} />
      </>)
    case 'text': {
      const updateText = (newParams: ShapeParams) => {
        if (newParams.type === 'text') loadFont(newParams.fontFamily).then(() => update(newParams))
      }
      return (<>
        <div className="flex items-center gap-1.5 col-span-2">
          <span className={labelCls}>T</span>
          <input type="text" value={params.text} onChange={(e) => updateText({ ...params, text: e.target.value })} className={fieldCls} />
        </div>
        <EditField label="Sz" valueMM={params.fontSize} units={u} min={0.1} onChange={(fontSize) => updateText({ ...params, fontSize })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Fnt</span>
          <FontSelect
            value={params.fontFamily}
            previewText={params.text}
            onChange={(family) => updateText({ ...params, fontFamily: family })}
            className="flex-1 w-0"
          />
        </div>
      </>)
    }
  }
})


export default function PropertiesPanel() {
  const liveRotationAngle = useCanvasStore((s) => s.liveRotationAngle)
  const liveBBox = useCanvasStore((s) => s.liveBBox)
  // Brief highlight when a timeline path-chip is clicked — this panel is where
  // that chip's shape/text parameters get amended.
  const flashSeq = useUIStore((s) => s.propertiesFlashSeq)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (flashSeq === 0) return
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), 1200)
    return () => clearTimeout(t)
  }, [flashSeq])
  const units = useWorkpieceStore((s) => s.units)
  const origin = useWorkpieceStore((s) => s.origin)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const orgWorld = originWorldXY(origin, widthMM, heightMM)
  const selectedPaths = useSelectedPaths()

  // EVERY HOOK ABOVE THE EARLY RETURNS. Two of these useMemos used to sit after
  // `return null`, so a panel whose selection resolved to nothing (ids of paths just
  // deleted) rendered a different number of hooks than the render before it.
  //
  // Memoised on the selection: this panel re-renders on every frame of a canvas drag, and
  // the selection's box does not change during one — the live box is `liveBBox`.
  const bbox = useMemo(
    () => (selectedPaths.length > 0 ? getMultiBBox(selectedPaths.map((p) => p.d)) : null),
    [selectedPaths],
  )

  // A multi-part shape (a gear) IS one shape — its parts share one set of params
  // and editing any of them regenerates the whole group. So a selection sitting
  // entirely inside one group is that shape, not a multi-select: without this,
  // clicking a gear's timeline chip (which selects every part) showed the generic
  // multi-path panel instead of the gear's parameters.
  const groupShape = selectedPaths.length > 1 && selectedPaths[0].groupId
    && selectedPaths.every((p) =>
      p.groupId === selectedPaths[0].groupId && p.shapePart !== undefined && p.shapeParams)
    ? selectedPaths[0] : null
  const singleShape = (selectedPaths.length === 1 && selectedPaths[0].shapeParams ? selectedPaths[0] : null)
    ?? groupShape

  // The shape's OWN fields, moved by the gesture in flight — so the panel needs
  // no second copy of X/Y/W/H underneath, which is where the duplication came
  // from (and they disagreed, the stored params being pre-gesture). The live
  // step is React state inside CanvasStage rather than a store field, but for a
  // resize the two bounding boxes say everything about it: the axis-aligned scale
  // that carries `bbox`'s size onto `liveBBox`'s carries the parameters with it.
  //
  // SCALED, NOT TRANSLATED. No field in the Shape section states a position — where a
  // thing sits is the Transform section's, read off the bbox — so translating the params
  // changed nothing on screen, while building a NEW params object on every frame of a
  // move and re-rendering the whole editor for it. Untranslated, a move hands the editor
  // the same object throughout and the memoised editor skips every frame; a resize still
  // updates its sizes live. (The anchor of the scale is then immaterial for the same
  // reason: it only decides where the scaled shape would sit.)
  //
  // A rotate has no liveBBox and needs none: it SPILLS into the placement, so
  // the definition genuinely does not change and the live angle is reported by
  // RotationField below. Same for a scale a shape cannot express, where
  // `scaleShapeParams` returns null and the stored params stand.
  const liveShapeParams = useMemo(() => {
    const params = singleShape?.shapeParams
    if (!params || !liveBBox || !bbox || bbox.width === 0 || bbox.height === 0) return params
    const sx = liveBBox.width / bbox.width
    const sy = liveBBox.height / bbox.height
    if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9) return params
    return scaleShapeParams(params, bbox.minX, bbox.minY, sx, sy) ?? params
  }, [singleShape?.shapeParams, liveBBox, bbox])

  // How far the selection already stands turned, out of its placement recipe:
  // the angle of the transformed x-axis. Exact for a chain of rotates, mirrors
  // and uniform scales; for one carrying a skew or a stretch it is the nearest
  // honest single number, which is what a one-field readout can say anyway.
  // Only for a lone path — two paths can stand at two angles.
  // OVER THE WHOLE SELECTION, not a lone path — a MULTI-PART shape is several
  // paths, so `length !== 1` meant a gear, a cam, an escapement and a clock
  // wheel all reported 0° while standing visibly turned. They are rotated
  // together, so their parts carry the same angle and the selection has one
  // answer; a part dragged off on its own keeps that angle too, since a drag
  // adds a translate and turns nothing. Two paths at genuinely DIFFERENT angles
  // have no single answer, and 0 is what the field can honestly say.
  const placedAngle = useMemo(() => {
    const angles = selectedPaths.map((p) => placedAngleDeg(p.placement))
    if (angles.length === 0) return 0
    const first = angles[0]
    if (angles.some((d) => Math.abs(d - first) > 1e-6)) return 0
    return Math.abs(first) < 1e-9 ? 0 : first
  }, [selectedPaths])

  if (selectedPaths.length === 0) return null
  if (!bbox) return null

  const fmt = (n: number) => n.toFixed(2)

  // During a drag, compute the live bbox for display:
  // - translate/scale: CanvasStage pushes the exact bbox into the store
  // - rotate: derive from the original bbox + live angle (center stays fixed, AABB formula)
  const displayBBox = liveBBox ?? (liveRotationAngle !== null ? (() => {
    const { cx, cy, width, height } = bbox
    const rad = liveRotationAngle * Math.PI / 180
    const ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad))
    const hw = width / 2, hh = height / 2
    const nHW = hw * ca + hh * sa, nHH = hw * sa + hh * ca
    return { minX: cx - nHW, minY: cy - nHH, width: nHW * 2, height: nHH * 2 }
  })() : bbox)

  // The Transform section's fields are absolute — the position and size the
  // selection should HAVE — but a transform step is a delta, so each converts
  // one into the other against the live bbox. Same road as a canvas drag, so a
  // typed move and a dragged one leave the same recipe behind.
  function applyTransform(step: TransformStep, gesture: 'move' | 'scale') {
    bakePathsStep(selectedPaths.map((p) => p.id), step, gesture)
  }

  function applyTranslate(dx: number, dy: number) {
    applyTransform({ kind: 'translate', dx, dy }, 'move')
  }

  // Resizing holds the selection's top-left corner still, which is the corner a
  // typed width grows away from — matching the default drag, where the anchor is
  // the handle opposite the one being pulled.
  function applyResize(w: number, h: number) {
    if (!bbox || bbox.width === 0 || bbox.height === 0) return
    const sx = w / bbox.width, sy = h / bbox.height
    applyTransform({ kind: 'scale', sx, sy, ax: bbox.minX, ay: bbox.maxY }, 'scale')
  }

  function applyRotation(angle: number) {
    if (!bbox) return
    const cx = (bbox.minX + bbox.maxX) / 2
    const cy = (bbox.minY + bbox.maxY) / 2
    bakePathsStep(selectedPaths.map((p) => p.id), { kind: 'rotate', angle, cx, cy }, 'rotate')
  }

  function applyMirror(axis: 'x' | 'y') {
    if (!bbox) return
    const cx = (bbox.minX + bbox.maxX) / 2
    const cy = (bbox.minY + bbox.maxY) / 2
    bakePathsStep(selectedPaths.map((p) => p.id), { kind: 'mirror', axis, cx, cy }, 'mirror')
  }

  // How this object grows — outward from its middle, or from a fixed corner.
  // Reads the PATH, not its shapeParams: it has to survive a gesture that leaves
  // the parameters describing an untransformed definition, and it also lets an
  // imported outline with no parameters at all carry the setting. It is rendered
  // ONCE now, at the end of the one panel body — there used to be a second copy
  // in the transform-recipe editor, because that editor replaced this whole body
  // and a setting whose subject is what the NEXT resize does is useless if it
  // vanishes the moment you resize. With that editor gone, so is the second copy.
  //
  // Over the whole selection: ticked when they ALL are, and toggling sets them
  // all, which matches how the resize itself treats a group.
  const fromCentreRow = selectedPaths.length > 0 ? (
    <label
      className="col-span-2 flex items-center gap-1.5 cursor-pointer pt-1"
      title="Resize about the middle instead of holding the opposite corner still"
    >
      <input
        type="checkbox"
        className="accent-blue-500 w-3.5 h-3.5"
        checked={selectedPaths.every((p) => p.fromCenter)}
        onChange={(e) => usePathsStore.getState().batchUpdatePaths(
          selectedPaths.map((p) => ({ id: p.id, d: p.d, fromCenter: e.target.checked })))}
      />
      <span className="text-label text-gray-500 dark:text-neutral-400">Resize from centre</span>
    </label>
  ) : null

  return (
    // GROWS DOWNWARD, and that is the whole of these three classes.
    //
    // It used to be the last child of a column whose other half was `flex-1`, so
    // its box was pinned to the BOTTOM of the sidebar and every line it gained
    // pushed its own top edge — and every field on it — upward. Which is fine
    // until a field publishes a warning: the panel gets a line taller mid-click,
    // the spinner arrow slides out from under the pointer, and the next click
    // lands on nothing. Anything that appears and disappears with a value does
    // it — the red errors, the yellow notes, the blue hub line.
    //
    // So the panel takes the free space instead (`flex-1`) and scrolls INSIDE it
    // (`min-h-0 overflow-y-auto`). Its top edge is then fixed by whatever sits
    // above, which does not move, and a warning grows into the space below.
    <div className={[
      'border-t border-gray-300 dark:border-neutral-700 px-3 py-2 flex-1 min-h-0 overflow-y-auto transition-shadow duration-300',
      flashing ? 'ring-2 ring-inset ring-blue-500' : '',
    ].join(' ')}>
      <p className="text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1.5">
        {selectedPaths.length === 1 ? selectedPaths[0].name : `${selectedPaths.length} paths`}
      </p>

      {/* ONE PANEL, TWO SECTIONS: what the thing IS, then where it SITS.
          There used to be four presentations of this — the shape's own fields,
          a read-only bbox block for a path that had none, the rotation field and
          mirror buttons, and a whole separate transform-recipe body that
          REPLACED all of them. The fourth existed only because a rotate, a skew
          or a scale used to destroy `shapeParams`, leaving its recipe as the
          sole surviving record; parameters now spill into `placement` instead,
          so that case no longer exists and the recipe editor had become an
          orphan (the object strip is one chip per THING and carries no transform
          chip, so nothing could even reopen it — it only ever appeared by
          opening itself over whatever the user was working on).

          The Transform section shows only what the Shape section does not
          already state, which is what keeps a rectangle from listing X, Y, W and
          H twice. The test is `x`/`cx` and `w`/`h` in the params — a question
          asked of the object, so no per-type list can fall out of date as shapes
          are added. Everything here is live during a gesture and editable when
          not, for a pen path exactly as for a gear. */}
      {liveShapeParams && singleShape && (
        <>
          <SectionLabel>Shape</SectionLabel>
          <div className="grid grid-cols-2 gap-1.5">
            <ShapeParamsEditor id={singleShape.id} params={liveShapeParams} units={units} fromCenter={singleShape.fromCenter} />
          </div>
        </>
      )}

      {(() => {
        const params = liveShapeParams
        const statesSize = !!params && 'w' in params && 'h' in params
        // POSITION IS ALWAYS HERE, ALWAYS THE CENTRE, and never in the Shape
        // section. Every shape used to state its own, in whatever terms its
        // params happened to store — a rectangle its low corner, a circle its
        // centre — so the same question was answered two ways depending on what
        // was selected, and the rectangle's answer moved when its width was
        // typed. Where a thing sits is a property of the placement, not of the
        // shape; one field, one meaning, one place, for a pen path exactly as
        // for a gear. Taken from the bbox, so it is what is actually drawn: on
        // a gear that includes the pinion beside it, which is the extent the
        // stock has to hold.
        const posX = displayBBox!.minX + displayBBox!.width / 2
        const posY = displayBBox!.minY + displayBBox!.height / 2
        const live = liveRotationAngle !== null || liveBBox !== null
        return (
          <>
            {params && <SectionLabel>Transform</SectionLabel>}
            <div className="grid grid-cols-2 gap-1.5 space-y-0">
              {live ? (<>
                <ReadField label="CX" value={fmt(posX - orgWorld.x)} units="mm" />
                <ReadField label="CY" value={fmt(posY - orgWorld.y)} units="mm" />
              </>) : (<>
                <EditField label="CX" valueMM={posX - orgWorld.x} units={units} min={-1e6}
                  onChange={(v) => applyTranslate(v + orgWorld.x - posX, 0)} />
                <EditField label="CY" valueMM={posY - orgWorld.y} units={units} min={-1e6}
                  onChange={(v) => applyTranslate(0, v + orgWorld.y - posY)} />
              </>)}
              {!statesSize && (live ? (<>
                <ReadField label="W" value={fmt(displayBBox!.width)} units="mm" />
                <ReadField label="H" value={fmt(displayBBox!.height)} units="mm" />
              </>) : (<>
                <EditField label="W" valueMM={displayBBox!.width} units={units}
                  onChange={(v) => applyResize(v, displayBBox!.height)} />
                <EditField label="H" valueMM={displayBBox!.height} units={units}
                  onChange={(v) => applyResize(displayBBox!.width, v)} />
              </>))}
            </div>
          </>
        )
      })()}

      <div className="mt-1.5">
        <RotationField liveAngle={liveRotationAngle} baseAngle={placedAngle} onApply={applyRotation} />
      </div>

      <div className="mt-1.5 flex gap-1.5">
        <button
          onClick={() => applyMirror('x')}
          title="Mirror horizontally (flip left/right)"
          className="flex-1 text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
        >
          <span className="inline-block">↔</span> Mirror X
        </button>
        <button
          onClick={() => applyMirror('y')}
          title="Mirror vertically (flip up/down)"
          className="flex-1 text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
        >
          <span className="inline-block rotate-90">↔</span> Mirror Y
        </button>
      </div>

      {/* Group / Ungroup — tie the selection together so it clicks, drags and
          deletes as one thing, or dissolve the groups it touches. Alt-click on
          the canvas (or the paths list) still reaches a single member. */}
      {(() => {
        const gid0 = outerGroupOf(selectedPaths[0])
        const isWholeGroup = !!gid0 && selectedPaths.every((p) => outerGroupOf(p) === gid0)
          && usePathsStore.getState().paths.filter((p) => outerGroupOf(p) === gid0).length === selectedPaths.length
        const canGroup = selectedPaths.length > 1 && !isWholeGroup
        const canUngroup = selectedPaths.some((p) => outerGroupOf(p))
        if (!canGroup && !canUngroup) return null
        return (
          <div className="mt-1.5 flex gap-1.5">
            {canGroup && (
              <button
                onClick={() => usePathsStore.getState().groupSelected()}
                title="Group the selected paths so they select and move as one"
                className="flex-1 text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
              >
                Group
              </button>
            )}
            {canUngroup && (
              <button
                onClick={() => usePathsStore.getState().ungroupSelected()}
                title="Break the group up into its separate paths"
                className="flex-1 text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
              >
                Ungroup
              </button>
            )}
          </div>
        )
      })()}

      {selectedPaths.length === 1 && (() => {
        const p = selectedPaths[0]
        const isCompound = splitCompoundPath(p.d).length > 1
        if (!isCompound) return null
        return (
          <button
            onClick={() => usePathsStore.getState().splitPath(p.id, splitCompoundPath(p.d))}
            className="mt-2 w-full text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
          >
            Split Paths
          </button>
        )
      })()}

      {/* WHERE IT SITS RELATIVE TO SOMETHING ELSE, after where it sits outright.
          A constraint is the one thing on this panel whose subject is a PAIR of
          objects, so it reads last — the fields above answer "where is this",
          and this answers "and what is holding it there". */}
      <ConstraintsSection />

      {/* Last, matching where the transform-recipe body puts it — a control that
          jumped position when the panel swapped bodies read as a different
          control. */}
      {fromCentreRow && <div className="grid grid-cols-2">{fromCentreRow}</div>}
    </div>
  )
}
