import { useEffect, useState } from 'react'
import { ICON } from '../../theme'
import { Square, Circle, Ellipse, Hexagon, Star as StarIcon, PenTool, Type, Squircle, Heart, Pill, Signpost, Shield, Orbit, Grid3x3, CookingPot, Cog, Cloud, Anchor, Dices, ChevronDown, Clock, Weight, TrainTrack } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { spirographLoops, spirographRadii, spirographCentrePen, SPIRO_RATIO_RANGE, SCALE_LOCKED_SHAPES, type ShapeType, type ShapeToolConfig } from '../../shapes/shapeGenerators'
import { mazeGrid } from '../../shapes/mazeGenerator'
import { gearDims, gearHubOf, gearLabel, gearMesh, gearRimW, gearRotationSense, gearSpokeW, pinionDims, pinionLabel, TOOTH_LABEL_SIZE } from '../../shapes/gearGenerator'
import { hubGrownWhy } from '../../shapes/spokedWheel'
import { camDims } from '../../shapes/camGenerator'
import type { EscapementSpec } from '../../shapes/escapementGenerator'
import EscapementInfoButton from '../EscapementInfoButton'
import { pendulumDims } from '../../shapes/pendulumGenerator'
import { trackDims, BRIO } from '../../shapes/trackGenerator'
import { BOARD_EDGE_LABEL, BOARD_HANDLE_LABELS, BOARD_HANDLE_HAS_INSET, BOARD_HANDLE_DEFAULTS } from '../../shapes/cuttingBoardGenerator'
import { loadFont, isFontLoaded, SINGLE_LINE_FONT_FAMILY } from '../../shapes/textGenerator'
import { PATH_COLOR } from '../../colors'
import { NumericInput } from '../../components/NumericInput'
import FontSelect from '../../components/FontSelect'
import { NumInput, PlainInput, Select, Check, UnitSpacer, SliderValue, inputCls, labelCls, toolBtnCls, toolBtnState } from './shared'


const LS_TEXT_KEY = 'kam:textConfig'

const SHAPES: { type: ShapeType; label: string; icon: React.ReactNode }[] = [
  { type: 'rectangle', label: 'Rect',    icon: <Square size={ICON.md} /> },
  { type: 'roundrect',   label: 'Round',   icon: <Squircle size={ICON.md} /> },
  { type: 'inroundrect', label: 'Sign',    icon: <Signpost size={ICON.md} /> },
  { type: 'circle',    label: 'Circle',  icon: <Circle size={ICON.md} /> },
  { type: 'ellipse',   label: 'Ellipse', icon: <Ellipse size={ICON.md} /> },
  { type: 'polygon',   label: 'Polygon', icon: <Hexagon size={ICON.md} /> },
  { type: 'star',      label: 'Star',    icon: <StarIcon size={ICON.md} /> },
  { type: 'heart',     label: 'Heart',   icon: <Heart size={ICON.md} /> },
  { type: 'slot',      label: 'Slot',    icon: <Pill size={ICON.md} /> },
  { type: 'shield',    label: 'Shield',  icon: <Shield size={ICON.md} /> },
  { type: 'spirograph', label: 'Spiro',  icon: <Orbit size={ICON.md} /> },
  { type: 'maze',      label: 'Maze',    icon: <Grid3x3 size={ICON.md} /> },
  { type: 'board',     label: 'Board',   icon: <CookingPot size={ICON.md} /> },
  { type: 'gear',      label: 'Gear',    icon: <Cog size={ICON.md} /> },
  { type: 'cam',       label: 'Cam',     icon: <Cloud size={ICON.md} /> },
  { type: 'escapement', label: 'Escape', icon: <Anchor size={ICON.md} /> },
  { type: 'pendulum', label: 'Pend',    icon: <Weight size={ICON.md} /> },
  { type: 'track',    label: 'Track',   icon: <TrainTrack size={ICON.md} /> },
]

const SHAPE_META: Record<string, { label: string; icon: React.ReactNode }> = Object.fromEntries(
  SHAPES.map((s) => [s.type, { label: s.label, icon: s.icon }])
)

function ShapeConfig({ type, config, onChange, units }: {
  type: ShapeType; config: ShapeToolConfig; onChange: (c: ShapeToolConfig) => void; units: string
}) {
  const c = config
  const u = units

  switch (type) {
    case 'rectangle':
      return (<div className="space-y-1">
        <NumInput label="Width"  valueMM={c.rectangle.w} units={u} onChange={(w) => onChange({ ...c, rectangle: { ...c.rectangle, w } })} />
        <NumInput label="Height" valueMM={c.rectangle.h} units={u} onChange={(h) => onChange({ ...c, rectangle: { ...c.rectangle, h } })} />
      </div>)
    case 'roundrect':
      return (<div className="space-y-1">
        <NumInput label="Width"  valueMM={c.roundrect.w} units={u} onChange={(w) => onChange({ ...c, roundrect: { ...c.roundrect, w } })} />
        <NumInput label="Height" valueMM={c.roundrect.h} units={u} onChange={(h) => onChange({ ...c, roundrect: { ...c.roundrect, h } })} />
        <NumInput label="Radius" valueMM={c.roundrect.r} units={u} min={0} onChange={(r) => onChange({ ...c, roundrect: { ...c.roundrect, r } })} />
      </div>)
    case 'inroundrect':
      return (<div className="space-y-1">
        <NumInput label="Width"  valueMM={c.inroundrect.w} units={u} onChange={(w) => onChange({ ...c, inroundrect: { ...c.inroundrect, w } })} />
        <NumInput label="Height" valueMM={c.inroundrect.h} units={u} onChange={(h) => onChange({ ...c, inroundrect: { ...c.inroundrect, h } })} />
        <NumInput label="Radius" valueMM={c.inroundrect.r} units={u} min={0} onChange={(r) => onChange({ ...c, inroundrect: { ...c.inroundrect, r } })} />
      </div>)
    case 'circle':
      return (<div className="space-y-1">
        <NumInput label="Radius" valueMM={c.circle.radius} units={u} onChange={(radius) => onChange({ ...c, circle: { radius } })} />
      </div>)
    case 'ellipse':
      return (<div className="space-y-1">
        <NumInput label="Width"  valueMM={c.ellipse.rx * 2} units={u} onChange={(w) => onChange({ ...c, ellipse: { ...c.ellipse, rx: w / 2 } })} />
        <NumInput label="Height" valueMM={c.ellipse.ry * 2} units={u} onChange={(h) => onChange({ ...c, ellipse: { ...c.ellipse, ry: h / 2 } })} />
      </div>)
    case 'polygon':
      return (<div className="space-y-1">
        <NumInput label="Radius" valueMM={c.polygon.radius} units={u} onChange={(radius) => onChange({ ...c, polygon: { ...c.polygon, radius } })} />
        <NumInput label="Sides"  valueMM={c.polygon.sides} units="" min={3} integer onChange={(sides) => onChange({ ...c, polygon: { ...c.polygon, sides: Math.max(3, Math.round(sides)) } })} />
      </div>)
    case 'star':
      return (<div className="space-y-1">
        <NumInput label="Outer R" valueMM={c.star.outerRadius} units={u} onChange={(r) => onChange({ ...c, star: { ...c.star, outerRadius: r } })} />
        <NumInput label="Inner R" valueMM={c.star.innerRadius} units={u} onChange={(r) => onChange({ ...c, star: { ...c.star, innerRadius: r } })} />
        <NumInput label="Points"  valueMM={c.star.points} units="" min={3} integer onChange={(pts) => onChange({ ...c, star: { ...c.star, points: Math.max(3, Math.round(pts)) } })} />
      </div>)
    case 'heart':
      return (<div className="space-y-1">
        <NumInput label="Radius" valueMM={c.heart.curveRadius} units={u} onChange={(curveRadius) => onChange({ ...c, heart: { ...c.heart, curveRadius } })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Angle</span>
          <NumericInput
            value={c.heart.angle}
            min={1} max={179} step={5}
            onChange={(angle) => onChange({ ...c, heart: { ...c.heart, angle } })}
            className={inputCls}
            unit="°"
            unitCol
          />
        </div>
      </div>)
    case 'slot':
      return (<div className="space-y-1">
        <NumInput label="Length" valueMM={c.slot.length} units={u} onChange={(length) => onChange({ ...c, slot: { ...c.slot, length: Math.max(length, c.slot.width) } })} />
        <NumInput label="Width"  valueMM={c.slot.width}  units={u} onChange={(width)  => onChange({ ...c, slot: { ...c.slot, width: Math.min(width, c.slot.length) } })} />
      </div>)
    case 'shield':
      return (<div className="space-y-1">
        <NumInput label="Width"  valueMM={c.shield.w} units={u} onChange={(w) => onChange({ ...c, shield: { ...c.shield, w } })} />
        <NumInput label="Height" valueMM={c.shield.h} units={u} onChange={(h) => onChange({ ...c, shield: { ...c.shield, h } })} />
      </div>)
    case 'spirograph': {
      const { radius, p } = c.spirograph
      const loops = spirographLoops(c.spirograph.ratio)
      const { R, r } = spirographRadii(radius, loops, p)
      return (<div className="space-y-1">
        <NumInput label="Radius" valueMM={radius} units={u}
          onChange={(radius) => onChange({ ...c, spirograph: { ...c.spirograph, radius } })} />
        {/* A slider, because the loop count is the thing you hunt for by eye and
            an integer step means every position on it draws a different rosette. */}
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Loops</span>
          <input
            type="range" min={SPIRO_RATIO_RANGE.min} max={SPIRO_RATIO_RANGE.max} step={1} value={loops}
            onChange={(e) => {
              const ratio = spirographLoops(parseFloat(e.target.value))
              onChange({ ...c, spirograph: { ...c.spirograph, ratio, p: Math.min(p, ratio) } })
            }}
            className="flex-1 w-0 accent-blue-500"
          />
          <SliderValue>{loops}</SliderValue>
        </div>
        {/* max = loops leaves headroom past spirographCentrePen — where the
            curve fills right to the middle — without much dead travel beyond it,
            since the hole re-opens on the far side. */}
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Pen p</span>
          <input
            type="range" min={0} max={loops} step={0.01} value={p}
            onChange={(e) => onChange({ ...c, spirograph: { ...c.spirograph, p: parseFloat(e.target.value) } })}
            className="flex-1 w-0 accent-blue-500"
          />
          <SliderValue>{p.toFixed(2)}</SliderValue>
        </div>
        <p className="text-label text-gray-600 dark:text-neutral-400">
          Ring {fmtLen(R, u as 'mm' | 'in')} / wheel {fmtLen(r, u as 'mm' | 'in')} · R/r {loops}
          <br />
          centre at p {spirographCentrePen(loops).toFixed(2)}
        </p>
      </div>)
    }
    case 'maze': {
      const { w, h, spacing, corner, seed, loops } = c.maze
      const g = mazeGrid(w, h, spacing)
      const set = (patch: Partial<ShapeToolConfig['maze']>) => onChange({ ...c, maze: { ...c.maze, ...patch } })
      return (<div className="space-y-1">
        <NumInput label="Width"   valueMM={w} units={u} onChange={(w) => set({ w })} />
        <NumInput label="Height"  valueMM={h} units={u} onChange={(h) => set({ h })} />
        <NumInput label="Spacing" valueMM={spacing} units={u} onChange={(spacing) => set({ spacing })} />
        <NumInput label="Corner"  valueMM={corner} units={u} min={0} onChange={(corner) => set({ corner })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Seed</span>
          <NumericInput value={seed} min={1} max={999999} step={1} integer
            onChange={(seed) => set({ seed: Math.max(1, Math.round(seed)) })}
            className={inputCls} />
          <button
            onClick={() => set({ seed: 1 + Math.floor(Math.random() * 999999) })}
            title="New maze"
            className="p-1 rounded text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200 hover:bg-gray-200/70 dark:hover:bg-neutral-700 flex-shrink-0"
          >
            <Dices size={ICON.sm} />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Loops</span>
          <input type="range" min={0} max={1} step={0.05} value={loops}
            onChange={(e) => set({ loops: parseFloat(e.target.value) })}
            className="flex-1 w-0 accent-blue-500" />
          <SliderValue>{Math.round(loops * 100)}%</SliderValue>
        </div>
        {/* The pitch is what the walls are actually left at — it rounds up from
            Spacing to fit whole cells, so show it rather than the request. */}
        <p className="text-label text-gray-600 dark:text-neutral-400">
          {g.cols} × {g.rows} cells · pitch {fmtLen(g.dx, u as 'mm' | 'in')} × {fmtLen(g.dy, u as 'mm' | 'in')}
          <br />
          Wall = pitch − cutter Ø
        </p>
      </div>)
    }
    case 'board': {
      const b = c.board
      const set = (patch: Partial<ShapeToolConfig['board']>) => onChange({ ...c, board: { ...c.board, ...patch } })
      const edgeLabel = BOARD_EDGE_LABEL[b.shape]
      const handleLabels = BOARD_HANDLE_LABELS[b.handle]
      return (<div className="space-y-1">
        <Select label="Shape" value={b.shape}
          options={[['rect', 'Rectangle'], ['oval', 'Oval'], ['barrel', 'Barrel']]}
          onChange={(shape) => set({ shape })} />
        <NumInput label="Width"  valueMM={b.w} units={u} onChange={(w) => set({ w })} />
        <NumInput label="Height" valueMM={b.h} units={u} onChange={(h) => set({ h })} />
        {edgeLabel && <NumInput label={edgeLabel} valueMM={b.corner} units={u} min={0} onChange={(corner) => set({ corner })} />}
        <Select label="Handle" value={b.handle}
          options={[['none', 'None'], ['paddle', 'Paddle'], ['grips', 'Side slots'], ['slot', 'End slot']]}
          onChange={(handle) => set({ handle, ...BOARD_HANDLE_DEFAULTS[handle] })} />
        {handleLabels && (<>
          <NumInput label={handleLabels[0]} valueMM={b.handleW} units={u} onChange={(handleW) => set({ handleW })} />
          <NumInput label={handleLabels[1]} valueMM={b.handleL} units={u} onChange={(handleL) => set({ handleL })} />
        </>)}
        {BOARD_HANDLE_HAS_INSET[b.handle] &&
          <NumInput label="Edge gap" valueMM={b.handleInset} units={u} onChange={(handleInset) => set({ handleInset })} />}
        {/* A hand slot IS the hole, so a hanging hole would just be a second one
            competing for the same end of the board. */}
        {!BOARD_HANDLE_HAS_INSET[b.handle] && (<>
          <Check label="Hole" checked={b.hole} onChange={(hole) => set({ hole })} />
          {b.hole && <NumInput label="Hole Ø" valueMM={b.holeDia} units={u} onChange={(holeDia) => set({ holeDia })} />}
        </>)}
        <Check label="Groove" checked={b.groove} onChange={(groove) => set({ groove })} />
        {b.groove && <NumInput label="Inset" valueMM={b.grooveInset} units={u} onChange={(grooveInset) => set({ grooveInset })} />}
        <p className="text-label text-gray-600 dark:text-neutral-400">
          Size is the cutting field; a paddle adds to it.
          <br />
          Double-click to split outline / groove / hole.
        </p>
      </div>)
    }
    case 'gear': {
      const g = c.gear
      const set = (patch: Partial<ShapeToolConfig['gear']>) => onChange({ ...c, gear: { ...c.gear, ...patch } })
      const cyc = g.toothProfile === 'cycloidal' ? { mateTeeth: g.mateTeeth, pinDia: g.pinDia } : undefined
      const relief = Math.round(Math.max(0, Math.min(1, g.backRelief ?? 0)) * 100)
      const pin = pinionDims({ ...g, cx: 0, cy: 0 })
      const pinLab = pinionLabel({ ...g, cx: 0, cy: 0 })
      const d = gearDims(g.module, g.teeth, g.pressureAngle, g.backlash, cyc)
      const mesh = gearMesh({ ...g, cx: 0, cy: 0 })
      const hub = gearHubOf({ ...g, cx: 0, cy: 0 })
      // A pin has to pass through the tooth space, or the pair cannot turn at all.
      // The root clears the pin and stops — usually SHALLOWER than the ISO
      // dedendum, since a lantern presents no tooth tip to make room for.
      const rootByPin = !!cyc && Math.abs(d.rootDia - g.module * (g.teeth - 2.5)) > 0.01
      const L = (mm: number) => fmtLen(mm, u as 'mm' | 'in')
      // The marking runs out along the right-hand spoke at whatever size that
      // takes — ask the generator rather than restating its rules. Position is
      // irrelevant to the fit.
      const lab = gearLabel({ ...g, cx: 0, cy: 0 })
      const labFontReady = isFontLoaded(SINGLE_LINE_FONT_FAMILY)
      return (<div className="space-y-1">
        <NumInput label="Module"  valueMM={g.module} units={u} min={0.05} onChange={(module) => set({ module })} />
        <NumInput label="Teeth"   valueMM={g.teeth} units="" min={4} integer onChange={(teeth) => set({ teeth: Math.max(4, Math.round(teeth)) })} />
        <Select label="Profile" value={g.toothProfile}
          options={[['involute', 'Involute'], ['cycloidal', 'Cycloidal (clock)']]}
          onChange={(toothProfile) => set({ toothProfile })} />
        {/* A cycloidal face is cut for ONE mate — the describing circle comes from
            the pinion's pitch circle — so the pinion is a parameter of the wheel,
            not a separate design. Pressure angle has no meaning here: it varies
            through a cycloidal mesh, so the field goes away with the profile. */}
        {cyc ? (<>
          <NumInput label="Pins"   valueMM={g.mateTeeth} units="" min={2} integer onChange={(mateTeeth) => set({ mateTeeth: Math.max(2, Math.round(mateTeeth)) })} />
          <NumInput label="Pin Ø"  valueMM={g.pinDia} units={u} min={0.1} onChange={(pinDia) => set({ pinDia })} />
          {/* A clock wheel turns one way, so one flank of each tooth never touches
              a pin and can be cut back to let the next pin in. Which flank that is
              is the whole risk: relieve the acting one and the wheel still looks
              and turns like a clock wheel with no face left to drive with. */}
          <PlainInput label="Back cut" value={relief} unit="%" min={0} max={100} step={10}
            onChange={(v) => set({ backRelief: Math.max(0, Math.min(1, v / 100)) })} />
          {/* The wheel's ROTATION, not the acting flank — the two are the same
              number here because a gear drawn on its own DRIVES its lantern, and
              opposite on a wheel the pins drive (see gearRotationSense). There is
              no driven-wheel default: that case is a clock's motion work, which
              the clock stamps, or a tick on the wheel's own properties.

              ALWAYS SHOWN, not only under back relief: it was gated on relief
              because direction is invisible in the TEETH without it, which stopped
              being the whole story once `gearPose` began turning the wheel the way
              this says and settling the mate on the flank it drives. Both show at
              0% relief, so the field that sets them has to be reachable there. */}
          <Select label="Runs" value={gearRotationSense({ ...g, cx: 0, cy: 0 }) === -1 ? 'cw' : 'ccw'}
            options={[['cw', 'Clockwise'], ['ccw', 'Anticlockwise']]}
            onChange={(v) => set({ actingSense: v === 'ccw' ? 1 : -1 })} />
          {/* The mate, drawn from these same numbers — cheek, pin holes, arbor. */}
          <Check label="Pinion" checked={g.emitPinion} onChange={(emitPinion) => set({ emitPinion })} />
        </>) : (
          <div className="flex items-center gap-1.5">
            <span className={labelCls}>Pressure</span>
            <NumericInput value={g.pressureAngle} min={5} max={35} step={0.5}
              onChange={(pressureAngle) => set({ pressureAngle })} className={inputCls} unit="°" unitCol />
          </div>
        )}
        <NumInput label="Bore Ø"  valueMM={g.bore} units={u} min={0} onChange={(bore) => set({ bore })} />
        {/* A floor, not a fixed size — it grows to seat the spokes. */}
        <NumInput label="Hub Ø"   valueMM={g.hubDia} units={u} min={0} onChange={(hubDia) => set({ hubDia })} />
        <NumInput label="Spokes"  valueMM={g.spokes} units="" min={0} integer onChange={(spokes) => set({ spokes: Math.max(0, Math.round(spokes)) })} />
        {/* The web's two thicknesses, in MILLIMETRES — how much wood is left
            holding the rim on is a question about the stock and the cutter, not
            about the tooth size. Both show their resolved value, so a gear that
            has never been dialled in reads 2.5·module and follows the module as
            it is stepped; typing 0 puts it back to that. */}
        <NumInput label="Spoke W" valueMM={gearSpokeW(g.module, g.spokeWidth)} units={u} min={0} onChange={(v) => set({ spokeWidth: v > 0 ? v : undefined })} />
        <NumInput label="Rim"     valueMM={gearRimW(g.module, g.rimWidth)} units={u} min={0} onChange={(v) => set({ rimWidth: v > 0 ? v : undefined })} />
        {/* Play at the MESH, so the same figure on both gears of a pair gives
            exactly that much — each is thinned by half. */}
        <NumInput label="Backlash" valueMM={g.backlash} units={u} min={0} step={0.05} onChange={(backlash) => set({ backlash })} />
        {/* Engraved, not cut — its own path, so it takes an engrave op or gets
            deleted without touching the gear. */}
        <Check label="Count #" checked={g.toothLabel} onChange={(toothLabel) => set({ toothLabel })} />
        <Check label="Pitch ○" checked={g.pitchCircle} onChange={(pitchCircle) => set({ pitchCircle })} />
        {/* Base Ø is m·z·cos α — derived, never dialled in, so it is shown
            rather than offered as a field. */}
        <p className="text-label text-gray-600 dark:text-neutral-400">
          {cyc
            ? <>Pitch {L(d.pitchDia)} · Describing {L(d.describingDia)}</>
            : <>Pitch {L(d.pitchDia)} · Base {L(d.baseDia)}</>}
          <br />
          Outside {L(d.outsideDia)} · Root {L(d.rootDia)}
          <br />
          Meshes at centre distance {L(d.pitchDia / 2)} + partner&apos;s pitch radius
          <br />
          Tooth {L(d.toothThickness)} at pitch{g.backlash > 0 ? ` (${L(Math.PI * g.module / 2)} nominal)` : ''}
          {/* The play the pair will really have. Two gears come out at the
              backlash; a lantern comes out at whatever the pin leaves, which is
              the one thing about a lantern mesh no drawing shows. */}
          <br />
          Play at the mesh {L(mesh.playAtPitch)}
        </p>
        {cyc && d.pinTooFat && <p className="text-label text-red-400">
          Ø{L(g.pinDia)} pins take the whole {L(d.circularPitch)} circular pitch — there is no tooth left to drive with.
          Thinner pins, or a bigger module.
        </p>}
        {hub.grown && <p className="text-label text-blue-400">Hub grown to {L(hub.dia)} {hubGrownWhy(hub, g.spokes)}.</p>}
        {(!(g.spokeWidth! > 0) || !(g.rimWidth! > 0)) && <p className="text-label text-gray-600 dark:text-neutral-400">
          {!(g.spokeWidth! > 0) && !(g.rimWidth! > 0) ? 'Spoke and rim follow the module' : !(g.spokeWidth! > 0) ? 'Spoke follows the module' : 'Rim follows the module'} at 2.5&times; — type a figure to pin it, 0 to let go.
        </p>}
        {g.spokes >= 2 && !hub.spoked && (
          <p className="text-label text-yellow-500">
            {hub.maxSpokes >= 2 ? `No room for ${g.spokes} spokes — this gear takes ${hub.maxSpokes}. Cut solid.`
                                : 'No room for a spoke web on this gear — cut solid.'}
          </p>
        )}
        {g.toothLabel && lab && (lab.sizeMM < TOOTH_LABEL_SIZE - 0.05
          ? <p className="text-label text-blue-400">Engraves &ldquo;{lab.text}&rdquo; at {L(lab.sizeMM)} — all the spoke will take.</p>
          : <p className="text-label text-gray-600 dark:text-neutral-400">Engraves &ldquo;{lab.text}&rdquo; along the right-hand spoke.</p>)}
        {g.toothLabel && !lab && labFontReady &&
          <p className="text-label text-yellow-500">No room beside the bore for a legible marking — none engraved.</p>}
        {g.pitchCircle && <p className="text-label text-yellow-500">
          Pitch circle{cyc && g.emitPinion ? 's are references' : ' is a reference'} — delete {cyc && g.emitPinion ? 'them' : 'it'} before cutting.
          {cyc && g.emitPinion ? ' They run through the pin centres and are tangent at the right spacing.' : ''}
        </p>}
        {d.pointed && <p className="text-label text-yellow-500">Teeth come to a point — OD reduced.</p>}
        {!cyc && d.undercut && <p className="text-label text-gray-600 dark:text-neutral-400">Under {Math.ceil(2 / Math.sin((g.pressureAngle * Math.PI) / 180) ** 2)} teeth at {g.pressureAngle}° — roots hobbed with an undercut, flank waisted below the base circle.</p>}

        {rootByPin && <p className="text-label text-blue-400">Root cut to {L(d.rootDia)} — just clears the pins.</p>}
        {cyc && <p className="text-label text-gray-600 dark:text-neutral-400">
          Faces cut for this {g.mateTeeth}-pin lantern pinion at Ø{L(g.pinDia)} — another pinion wants another wheel.
          {relief > 0 && <><br />
            Back of each tooth cut away{relief >= 100 ? ' to the middle of the tip' : ` by ${relief}% of the tip`} —
            it turns {gearRotationSense({ ...g, cx: 0, cy: 0 }) === -1 ? 'clockwise' : 'anticlockwise'} ONLY, and
            running it the other way turns the relieved side into the acting one.
          </>}
        </p>}
        {cyc && g.emitPinion && pin && <p className="text-label text-gray-600 dark:text-neutral-400">
          Pinion: cheek {L(pin.cheekDia)} · pins on {L(pin.pinCircleDia)}
          <br />
          Cut TWO cheeks — the wheel runs between them, so it must be thinner than their gap.
          <br />
          {/* The question this answers: the pinion's own radius for layout is arbor
              to pin CENTRE, i.e. half the pin circle — not the cheek. */}
          Arbors sit {L(pin.centreDistance)} apart: {L(d.pitchDia / 2)} wheel pitch radius + {L(pin.pinCircleDia / 2)} arbor-to-pin-centre. Drawn clear, not at that spacing.
          {g.toothLabel && pinLab && <><br />Cheek engraves &ldquo;{pinLab.text}&rdquo; — add it to the wheel&apos;s to get that spacing.</>}
        </p>}
        {cyc && g.emitPinion && pin && pin.pinGap < 1 && <p className="text-label text-yellow-500">
          Only {L(Math.max(0, pin.pinGap))} of wood between pin holes — fewer pins, or thinner ones.
        </p>}
      </div>)
    }
    case 'escapement': {
      const e = c.escapement
      const set = (patch: Partial<ShapeToolConfig['escapement']>) => onChange({ ...c, escapement: { ...c.escapement, ...patch } })
      const dead = e.escType === 'deadbeat'
      const Ang = ({ label, value, min, max, step, onChange: oc }: {
        label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void
      }) => (
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>{label}</span>
          <NumericInput value={value} min={min} max={max} step={step} onChange={oc} className={inputCls} unit="°" unitCol />
        </div>
      )
      return (<div className="space-y-1">
        <Select label="Type" value={e.escType}
          options={[['deadbeat', 'Deadbeat (Graham)'], ['recoil', 'Recoil (anchor)']]}
          onChange={(escType) => set({ escType })} />
        <NumInput label="Teeth"   valueMM={e.teeth} units="" min={6} integer onChange={(teeth) => set({ teeth: Math.max(6, Math.round(teeth)) })} />
        <NumInput label="Wheel Ø" valueMM={e.wheelDia} units={u} min={4} onChange={(wheelDia) => set({ wheelDia })} />
        <NumInput label="Tooth H" valueMM={e.toothDepth} units={u} min={0.5} onChange={(toothDepth) => set({ toothDepth })} />
        {/* Drop is at the WHEEL and lift at the ANCHOR — they are not the same
            angle measured twice, and the impulse is what is left of the beat. */}
        <Ang label="Drop"   value={e.drop} min={0.2} max={10} step={0.25} onChange={(drop) => set({ drop })} />
        <Ang label="Lift"   value={e.lift} min={0.5} max={12} step={0.25} onChange={(lift) => set({ lift })} />
        {dead ? (<>
          <Ang label="Lock" value={e.lock} min={0} max={10} step={0.25} onChange={(lock) => set({ lock })} />
          <Ang label="Draw" value={e.draw} min={0} max={10} step={0.5} onChange={(draw) => set({ draw })} />
        </>) : (
          <Ang label="Recoil" value={e.recoilArc} min={0.5} max={20} step={0.5} onChange={(recoilArc) => set({ recoilArc })} />
        )}
        <NumInput label="Arm W"   valueMM={e.armWidth} units={u} min={1} onChange={(armWidth) => set({ armWidth })} />
        <NumInput label="Bore Ø"  valueMM={e.bore} units={u} min={0} onChange={(bore) => set({ bore })} />
        <NumInput label="Hub Ø"   valueMM={e.hubDia} units={u} min={0} onChange={(hubDia) => set({ hubDia })} />
        <NumInput label="Spokes"  valueMM={e.spokes} units="" min={0} integer onChange={(spokes) => set({ spokes: Math.max(0, Math.round(spokes)) })} />
        <NumInput label="Arbor Ø" valueMM={e.anchorBore} units={u} min={0} onChange={(anchorBore) => set({ anchorBore })} />
        {/* The teeth lean the way the wheel runs, so this is geometry, not a view
            option — a wheel cut the wrong way round will not lock. */}
        <Check label="Clockwise" checked={e.clockwise} onChange={(clockwise) => set({ clockwise })} />
        {/* The readout used to sit here, a dozen lines of numbers in the
            smallest type the app has, wrapped three ways under the controls
            being clicked. It is a window now — see EscapementInfoPanel — and
            this button carries its status so nothing fatal can hide in it. */}
        <EscapementInfoButton spec={{ cx: 0, cy: 0, ...e } as unknown as EscapementSpec} />
      </div>)
    }
    case 'pendulum': {
      const pd = c.pendulum
      const set = (patch: Partial<ShapeToolConfig['pendulum']>) => onChange({ ...c, pendulum: { ...c.pendulum, ...patch } })
      const dm = pendulumDims({ ...pd, cx: 0, cy: 0 })
      const L = (mm: number) => fmtLen(mm, u as 'mm' | 'in')
      return (<div className="space-y-1">
        {/* Suspension hole to bob centre. The ONLY dimension the rate depends
            on — hence the beat readout right under it. */}
        <NumInput label="Length"  valueMM={pd.length} units={u} min={1} onChange={(length) => set({ length })} />
        <NumInput label="Rod W"   valueMM={pd.rodWidth} units={u} min={0.5} onChange={(rodWidth) => set({ rodWidth })} />
        <NumInput label="Bob W"   valueMM={pd.bobRx * 2} units={u} min={1} onChange={(w) => set({ bobRx: w / 2 })} />
        <NumInput label="Bob H"   valueMM={pd.bobRy * 2} units={u} min={1} onChange={(h) => set({ bobRy: h / 2 })} />
        <NumInput label="Hole Ø"  valueMM={pd.bore} units={u} min={0} onChange={(bore) => set({ bore })} />
        <p className="text-label text-gray-600 dark:text-neutral-400">
          Beats {dm.beatSeconds.toFixed(4)} s · period {dm.periodSeconds.toFixed(4)} s
          <br />
          Rod {L(dm.rodLength)} overall · hangs from the hole
          <br />
          Length is the hole to the BOB CENTRE — the only dimension the rate depends on.
        </p>
        {/* A wooden rod has mass of its own, which lifts the centre of
            oscillation above the bob centre. It always runs fast; the rating nut
            is what fixes it. Saying so is the honest version of a beat readout
            quoted to four places. */}
        <p className="text-label text-gray-600 dark:text-neutral-400">
          A real rod runs a little fast — regulate by raising the bob.
        </p>
        {dm.boreTooBig && <p className="text-label text-yellow-500">
          Hole takes most of the {L(pd.rodWidth)} rod — it has been clamped to leave a shoulder.
        </p>}
        {dm.bobTooSmall && <p className="text-label text-yellow-500">
          Bob is no wider than the rod — nothing to see, and nothing to weigh.
        </p>}
      </div>)
    }
    case 'cam': {
      const m = c.cam
      const set = (patch: Partial<ShapeToolConfig['cam']>) => onChange({ ...c, cam: { ...c.cam, ...patch } })
      const dm = camDims({ ...m, cx: 0, cy: 0 })
      const L = (mm: number) => fmtLen(mm, u as 'mm' | 'in')
      return (<div className="space-y-1">
        <NumInput label="Base Ø"  valueMM={m.baseDia} units={u} min={1} onChange={(baseDia) => set({ baseDia })} />
        {/* The rise per REVOLUTION sets the spiral's slope; what this cam can
            actually lift is that × sweep/360, which the readout gives. */}
        <NumInput label="Rise/rev" valueMM={m.riseMM} units={u} min={0.1} onChange={(riseMM) => set({ riseMM })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Sweep</span>
          <NumericInput value={m.sweepDeg} min={5} max={360} step={5}
            onChange={(sweepDeg) => set({ sweepDeg })} className={inputCls} unit="°" unitCol />
        </div>
        <NumInput label="Bore Ø"  valueMM={m.boreDia} units={u} min={0} onChange={(boreDia) => set({ boreDia })} />
        <NumInput label="Lever"   valueMM={m.handleLength} units={u} min={1} onChange={(handleLength) => set({ handleLength })} />
        <NumInput label="Lever W" valueMM={m.handleWidth} units={u} min={0.5} onChange={(handleWidth) => set({ handleWidth })} />
        <p className="text-label text-gray-600 dark:text-neutral-400">
          Stroke {L(dm.usableStroke)} over {m.sweepDeg}° · {L(dm.liftPerDeg)}/°
          <br />
          Base {L(dm.baseDia)} → crest {L(dm.maxDia)}
          <br />
          Pressure angle {dm.pressureAngleDeg.toFixed(1)}° at the base, {dm.pressureAngleAtCrestDeg.toFixed(1)}° at the crest
          <br />
          Double-click to split outline / bore.
        </p>
        {/* Friction is what holds a cam: tan φ under µ, and wood on wood is µ≈0.3
            (17°). Past 10° there is no margin left for a clamp. */}
        {dm.wontHold && <p className="text-label text-yellow-500">
          {dm.pressureAngleDeg.toFixed(1)}° at the base circle — friction may not hold it. Bigger base Ø, or less rise.
        </p>}
        {dm.handleTooShort && <p className="text-label text-yellow-500">
          Lever is inside the crest ({L(dm.maxDia / 2)}) — no leverage. Make it longer.
        </p>}
      </div>)
    }
    case 'track': {
      const m = c.track
      const set = (patch: Partial<ShapeToolConfig['track']>) => onChange({ ...c, track: { ...c.track, ...patch } })
      const dm = trackDims({ ...m, cx: 0, cy: 0 })
      const L = (mm: number) => fmtLen(mm, u as 'mm' | 'in')
      return (<div className="space-y-1">
        <Select label="Kind" value={m.kind}
          options={[['straight', 'Straight'], ['curve', 'Curve'], ['turnout', 'Turnout']]}
          onChange={(kind) => set({ kind })} />
        {m.kind !== 'curve' && (<>
          {/* Face to face, which is also what the piece adds to a layout — the
              peg lives inside its neighbour's socket. */}
          <NumInput label="Length" valueMM={m.length} units={u} min={20} onChange={(length) => set({ length })} />
          <div className="flex gap-1">
            {BRIO.lengths.map((mm) => (
              <button key={mm} type="button" onClick={() => set({ length: mm })}
                className={`flex-1 rounded border px-1 py-0.5 text-label ${Math.abs(m.length - mm) < 0.01
                  ? 'border-blue-500 bg-blue-500/20'
                  : 'border-gray-400 dark:border-neutral-600 hover:bg-gray-100 dark:hover:bg-neutral-700'}`}>
                {mm}
              </button>
            ))}
          </div>
        </>)}
        {m.kind !== 'straight' && (<>
          {/* To the CENTRELINE — the catalogue numbers are quoted off the inside
              edge as often as not, so the panel says which this is and reads the
              other two back. */}
          <NumInput label="Radius" valueMM={m.radius} units={u} min={m.width / 2 + 1} onChange={(radius) => set({ radius })} />
          <PlainInput label="Arc" value={m.sweepDeg} unit="°" min={1} max={350} step={5} onChange={(sweepDeg) => set({ sweepDeg })} />
        </>)}
        {m.kind === 'turnout' && (<>
          {/* Not a mirror: a mirrored path drops its shapeParams and stops
              being a turnout, so the hand has to be part of the recipe. */}
          <Select label="Hand" value={m.hand}
            options={[['left', 'Left'], ['right', 'Right']]}
            onChange={(hand) => set({ hand })} />
          {/* The crotch comes out of the union as a 41° notch — no bit cuts it
              and it is short grain both sides. This is the fillet in it. */}
          <NumInput label="Crotch" valueMM={m.crotch} units={u} min={0} onChange={(crotch) => set({ crotch })} />
        </>)}
        <Select label={m.kind === 'turnout' ? 'Toe' : 'End A'} value={m.endA}
          options={[['female', 'Socket'], ['male', 'Peg'], ['plain', 'Square']]}
          onChange={(endA) => set({ endA })} />
        <Select label={m.kind === 'turnout' ? 'Main' : 'End B'} value={m.endB}
          options={[['male', 'Peg'], ['female', 'Socket'], ['plain', 'Square']]}
          onChange={(endB) => set({ endB })} />
        {m.kind === 'turnout' &&
          <Select label="Branch" value={m.endC}
            options={[['male', 'Peg'], ['female', 'Socket'], ['plain', 'Square']]}
            onChange={(endC) => set({ endC })} />}
        <NumInput label="Width"  valueMM={m.width} units={u} min={10} onChange={(width) => set({ width })} />
        <NumInput label="Gauge"  valueMM={m.gauge} units={u} min={1} onChange={(gauge) => set({ gauge })} />
        <NumInput label="Peg Ø"  valueMM={m.pegDia} units={u} min={1} onChange={(pegDia) => set({ pegDia })} />
        <NumInput label="Neck W" valueMM={m.neckW} units={u} min={0.5} onChange={(neckW) => set({ neckW })} />
        <NumInput label="Neck L" valueMM={m.neckL} units={u} min={0.5} onChange={(neckL) => set({ neckL })} />
        {/* The socket is derived from the peg plus this one slack, so it can
            never be edited out of step with what has to go into it. */}
        <NumInput label="Clearance" valueMM={m.clearance} units={u} min={0.05} onChange={(clearance) => set({ clearance })} />
        {/* The sleeper marks — decoration, and the only thing on the piece that
            is not a fit against somebody else's track. Each one runs edge to
            edge in one line; where it crosses a groove the bit is over a 3 mm
            hole and cuts nothing. */}
        <Check label="Treads" checked={m.treads} onChange={(treads) => set({ treads })}
          title="Sleeper marks engraved right across the run" />
        {/* The pitch is also the standoff from each end face — that is what puts
            the joint between two pieces where a mark would have been. */}
        {m.treads &&
          <NumInput label="Tread pitch" valueMM={m.treadPitch} units={u} min={1} onChange={(treadPitch) => set({ treadPitch })} />}
        <p className="text-label text-gray-600 dark:text-neutral-400">
          {m.kind === 'curve'
            ? <>Chord {L(dm.pitch)} · inner {L(dm.innerRadius)} / outer {L(dm.outerRadius)}</>
            : <>Pitch {L(dm.pitch)} · {L(dm.overall)} overall</>}
          <br />
          {m.kind === 'curve' && <>{dm.closesCircle
            ? <>{Math.round(dm.perCircle)} make a circle</>
            : <>{dm.perCircle.toFixed(2)} to a circle — does not close</>}<br /></>}
          {/* Where the branch's outer groove crosses the straight's inner one.
              It falls out of the gauge alone, so a shallower branch does not
              move it — only a bigger radius does. */}
          {m.kind === 'turnout' && <>
            Frog {L(dm.frogDist)} from the toe, {dm.frogDeg.toFixed(1)}° round the branch
            <br />
            Branch steps {L(dm.divergeOffset)} aside over {m.sweepDeg}°
            <br />
          </>}
          Socket Ø {L(dm.socketDia)}, {L(dm.throatW)} throat {L(dm.throatL)} long
          <br />
          Peg reaches {L(dm.pegReach)} into a {L(dm.socketDepth)} socket
          <br />
          Grooves {L(BRIO.grooveW)} × {BRIO.grooveDepth} deep in {BRIO.thickness} stock, {L(dm.railMargin)} of rail outside
          <br />
          {m.treads && <>{dm.treadCount} treads, {L(dm.treadSpacing)} apart and off each face<br /></>}
          Grooves are centrelines — cut them with a {L(BRIO.grooveW)} bit. Double-click to split outline / grooves / treads.
        </p>
        {dm.grooveOffTrack && <p className="text-label text-yellow-500">
          Grooves run off the edge — gauge {L(m.gauge)} with {L(BRIO.grooveW)} slots needs {L(m.gauge + BRIO.grooveW)} of width.
        </p>}
        {dm.socketBreachesGroove && <p className="text-label text-yellow-500">
          Socket breaks into a groove — the centre spine is {L(dm.spineMargin)}. Wider gauge, or a smaller hole.
        </p>}
        {dm.socketsTooDeep && <p className="text-label text-yellow-500">
          Sockets are deeper than the piece is long — nothing solid left between them.
        </p>}
        {dm.pegTooThin && <p className="text-label text-yellow-500">
          Neck is as wide as the head — the peg has no shoulder to hold on.
        </p>}
        {dm.treadsCrowded && <p className="text-label text-yellow-500">
          Treads {L(dm.treadSpacing)} apart are closer than the flange slot is wide — that reads as a hatch.
        </p>}
        {dm.frogPastEnd && <p className="text-label text-yellow-500">
          Main leg ends inside the frog — it needs {L(dm.frogDist)} to finish the crossing.
        </p>}
        {dm.frogPastSweep && <p className="text-label text-yellow-500">
          Branch stops before the frog at {dm.frogDeg.toFixed(1)}° — the two routes never separate.
        </p>}
        {dm.heelsFoul && <p className="text-label text-yellow-500">
          Branch is only {L(dm.divergeOffset)} aside — less than the {L(m.width)} width, so the two
          heels are in each other's stock. More sweep, or a tighter radius.
        </p>}
      </div>)
    }
    case 'text':
      return (<div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Text</span>
          <input type="text" value={c.text.text} placeholder="Enter text…"
            onChange={(e) => onChange({ ...c, text: { ...c.text, text: e.target.value } })}
            className={inputCls} />
          <UnitSpacer />
        </div>
        <NumInput label="Size" valueMM={c.text.fontSize} units={u} min={0.1} onChange={(fontSize) => onChange({ ...c, text: { ...c.text, fontSize } })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Font</span>
          <FontSelect
            value={c.text.fontFamily}
            previewText={c.text.text}
            onChange={(family) => onChange({ ...c, text: { ...c.text, fontFamily: family } })}
            className="flex-1 w-0"
          />
          <UnitSpacer />
        </div>
      </div>)
  }
}

// The DEFAULT for shapes drawn from here — each one records it (see
// ImportedPath.fromCenter) and is changed afterwards from its own properties
// panel, the same as any other parameter.
//
// It rides with the ACTIVE shape tool's defaults rather than sitting on its own
// above them: it is a statement about what the next drag means, so with no shape
// tool in use it was a checkbox about nothing — and, the setting having become a
// per-object one, it read as a second place to change the selected shape. One
// definition, both defaults blocks, so the two cannot drift.
//
// A SCALE-LOCKED shape (gear, escapement, pendulum) is never offered it: it is
// placed at its designed size and the canvas draws it no resize handles, so
// neither gesture the flag governs exists for one — a mechanism's size comes from
// its module and tooth count, not from how far a cursor travelled.
function FromCentreCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Check
      label="From centre"
      checked={checked}
      onChange={onChange}
      title="New shapes grow outward from where the drag starts, and resize about their middle — for concentric work"
    />
  )
}

// ─── Main ShapePanel ──────────────────────────────────────────────────────────

export default function ShapePanel({ fill = false }: { fill?: boolean }) {
  const { activeTool, setActiveTool, shapeToolConfig, setShapeToolConfig, setShapesPanelOpen, setClockPanelOpen, penCurveType, setPenCurveType, lastShapeType, setLastShapeType, shapeFromCenter, setShapeFromCenter } = useUIStore()
  const { units } = useWorkpieceStore()
  const isShapeTool = SHAPES.some((s) => s.type === activeTool)
  const lastShape = SHAPE_META[lastShapeType] ?? SHAPE_META.rectangle

  const [fontReady, setFontReady] = useState(() => isFontLoaded(shapeToolConfig.text.fontFamily))

  useEffect(() => {
    if (activeTool !== 'text') return
    const family = shapeToolConfig.text.fontFamily
    if (isFontLoaded(family)) { setFontReady(true); return }
    setFontReady(false)
    loadFont(family).then(() => setFontReady(true))
  }, [activeTool, shapeToolConfig.text.fontFamily])

  useEffect(() => { loadFont(shapeToolConfig.text.fontFamily) }, [shapeToolConfig.text.fontFamily])

  // A gear's tooth-count number is set in the single-stroke face, so it has to be
  // in hand before one is drawn — and this panel's fit readout needs a re-render
  // once it is.
  const [countFontReady, setCountFontReady] = useState(() => isFontLoaded(SINGLE_LINE_FONT_FAMILY))
  useEffect(() => {
    if (activeTool !== 'gear' || countFontReady) return
    loadFont(SINGLE_LINE_FONT_FAMILY).then(() => setCountFontReady(true))
  }, [activeTool, countFontReady])

  // Load saved text config on mount
  useEffect(() => {
    const saved = localStorage.getItem(LS_TEXT_KEY)
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      setShapeToolConfig({ ...shapeToolConfig, text: { ...shapeToolConfig.text, ...parsed } })
    } catch {}
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const updateConfig = (config: ShapeToolConfig) => {
    setShapeToolConfig(config)
    localStorage.setItem(LS_TEXT_KEY, JSON.stringify(config.text))
  }

  useEffect(() => {
    if (!fill) return
    setActiveTool(lastShapeType)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill])

  // ── Full-panel shapes selector ─────────────────────────────────────────────
  if (fill) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
          <span className="text-body font-semibold text-gray-700 dark:text-neutral-300">Shapes</span>
          <button
            onClick={() => { setShapesPanelOpen(false); if (isShapeTool) setActiveTool('select') }}
            className="text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 text-sm leading-none"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {SHAPES.map(({ type, label, icon }) => (
              <button
                key={type}
                onClick={() => {
                  setActiveTool(type)
                  setLastShapeType(type)
                  setShapesPanelOpen(false)
                }}
                title={label}
                className={toolBtnCls(activeTool === type)}
              >
                <span style={{ color: PATH_COLOR }}>{icon}</span>
                <span className="text-label text-gray-500 dark:text-neutral-400">{label}</span>
              </button>
            ))}
            {/* Not a shape tool, and so not in SHAPES: a clock is a whole train
                worked out from the beat, emitted as five INDEPENDENT shapes with
                a chip each. It lives here because this is where a user looks for
                the gear and the escapement it is built from. */}
            <button
              onClick={() => { setActiveTool('select'); setShapesPanelOpen(false); setClockPanelOpen(true) }}
              title="Clock — a whole going train from the beat"
              className={toolBtnCls(false)}
            >
              <span style={{ color: PATH_COLOR }}><Clock size={ICON.md} /></span>
              <span className="text-label text-gray-500 dark:text-neutral-400">Clock</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Normal draw tool row ───────────────────────────────────────────────────
  return (
    <div className="px-3 py-2 space-y-2 border-b border-gray-300 dark:border-neutral-700">
      <p className="text-label font-semibold text-gray-600 dark:text-neutral-400 uppercase tracking-wider">Draw</p>
      <div className="grid grid-cols-3 gap-1">
        <button
          onClick={() => setActiveTool(activeTool === 'pen' ? 'select' : 'pen')}
          title="Pen Tool — click to add points, drag for curves"
          className={toolBtnCls(activeTool === 'pen')}
        >
          <span style={{ color: PATH_COLOR }}><PenTool size={ICON.md} /></span>
          <span className="text-label text-gray-500 dark:text-neutral-400">Pen</span>
        </button>
        <button
          onClick={() => setActiveTool(activeTool === 'text' ? 'select' : 'text')}
          title="Text Tool"
          className={toolBtnCls(activeTool === 'text')}
        >
          <span style={{ color: PATH_COLOR }}><Type size={ICON.md} /></span>
          <span className="text-label text-gray-500 dark:text-neutral-400">Text</span>
        </button>
        {/* Split control: the tile activates the last shape, the strip below opens
            the picker. The chevron used to float in the tile's top-right corner at
            19px square, on top of the full-width tile — two touch-target failures at
            once (under 24x24, and zero spacing between overlapping targets). Stacked
            instead of side-by-side because the sidebar resizes down to 180px, where a
            cell is ~48px: a 24px chevron column would leave 24px for a 32px icon.
            Full width costs ~24px of height and keeps the label legible at any size. */}
        <div className={`flex flex-col rounded text-body transition-colors border ${toolBtnState(isShapeTool)}`}>
          <button
            onClick={() => setActiveTool(activeTool === lastShapeType ? 'select' : lastShapeType)}
            title={`${lastShape.label} — click the chevron below to pick a different shape`}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 py-1.5"
          >
            <span style={{ color: PATH_COLOR }}>{lastShape.icon}</span>
            <span className="text-label text-gray-500 dark:text-neutral-400">{lastShape.label}</span>
          </button>
          <button
            onClick={() => setShapesPanelOpen(true)}
            title="Pick a different shape"
            className="h-6 flex items-center justify-center border-t border-inherit rounded-b text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200 hover:bg-gray-200/70 dark:hover:bg-neutral-700"
          >
            <ChevronDown size={ICON.sm} />
          </button>
        </div>
      </div>

      {isShapeTool && (
        <div className="space-y-1.5 pt-0.5">
          <p className="text-label text-gray-600 dark:text-neutral-400 font-medium capitalize">{activeTool} defaults</p>
          <ShapeConfig type={activeTool as ShapeType} config={shapeToolConfig} onChange={updateConfig} units={units} />
          {!SCALE_LOCKED_SHAPES.has(activeTool as ShapeType) &&
            <FromCentreCheck checked={shapeFromCenter} onChange={setShapeFromCenter} />}
        </div>
      )}

      {activeTool === 'text' && (
        <div className="space-y-1.5 pt-0.5">
          <p className="text-label text-gray-600 dark:text-neutral-400 font-medium">Text defaults</p>
          {!fontReady && <p className="text-label text-yellow-500">Loading font…</p>}
          <ShapeConfig type="text" config={shapeToolConfig} onChange={updateConfig} units={units} />
          <FromCentreCheck checked={shapeFromCenter} onChange={setShapeFromCenter} />
        </div>
      )}

      {activeTool === 'pen' && (
        <div className="space-y-1.5 pt-0.5">
          <p className="text-label text-gray-600 dark:text-neutral-400 font-medium">Curve type</p>
          <div className="grid grid-cols-3 gap-1">
            {([
              ['linear',       'Linear' ],
              ['bezier',       'Bezier' ],
              ['catmull-rom',  'C-Rom'  ],
              ['cubic-spline', 'Spline' ],
              ['arc-fit',      'Arc'    ],
            ] as const).map(([type, label]) => (
              <button
                key={type}
                onClick={() => setPenCurveType(type)}
                className={toolBtnCls(penCurveType === type)}
              >
                <span className="text-label">{label}</span>
              </button>
            ))}
          </div>
          <p className="text-label text-gray-600 dark:text-neutral-400">Alt: toggle linear / curve</p>
        </div>
      )}
    </div>
  )
}
