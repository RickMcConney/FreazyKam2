import { useState, useId } from 'react'
import { ICON } from '../theme'
import { ChevronDown, ChevronRight } from 'lucide-react'
import InfoPopover from '../components/InfoPopover'
import {
  useWorkpieceStore,
  MATERIAL_INFO,
  type OriginPosition,
  type Units,
  type Material,
  type MaterialKind,
  fromMM,
  toMM,
} from '../store/workpieceStore'
import { SPINDLE_INFO, type SpindleType } from '../store/spindle'
import { NumericInput } from '../components/NumericInput'
import { NUMERIC_HINT } from '../components/parseNumeric'
import { rigidityInfo } from '../rigidity'

function DimInput({
  label,
  valueMM,
  units,
  onChange,
  min = 0.1,
}: {
  label: string
  valueMM: number
  units: Units
  onChange: (mm: number) => void
  min?: number
}) {
  const displayVal = fromMM(valueMM, units)
  const step = units === 'in' ? 0.0625 : 1
  const rowId = useId()

  return (
    <div className="flex items-center gap-2 mb-1.5">
      <label htmlFor={rowId} className="text-gray-500 dark:text-neutral-400 text-body w-24 shrink-0">{label}</label>
      <NumericInput
        id={rowId}
        value={displayVal}
        min={min}
        step={step}
        title={NUMERIC_HINT}
        unit={units}
        onChange={(v) => onChange(toMM(v, units))}
        className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-600 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none font-mono"
      />
    </div>
  )
}

// A machine-motion number: stored in mm (mm/s², mm/min, mm), shown in the display units.
function MotionInput({ label, valueMM, units, unit, stepMM, stepIn, onChange }: {
  label: string
  valueMM: number
  units: Units
  unit: string
  stepMM: number
  stepIn: number
  onChange: (mm: number) => void
}) {
  const rowId = useId()
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <label htmlFor={rowId} className="text-gray-500 dark:text-neutral-400 text-body w-24 shrink-0">{label}</label>
      <NumericInput
        id={rowId}
        value={fromMM(valueMM, units)}
        min={0}
        step={units === 'in' ? stepIn : stepMM}
        title={NUMERIC_HINT}
        unit={unit}
        onChange={(v) => onChange(toMM(v, units))}
        className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-600 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none font-mono"
      />
    </div>
  )
}

const MOTION_HELP =
  "How your controller accelerates and takes corners. Copy them from its settings — FluidNC: " +
  "acceleration_mm_per_sec2 (X and Z), max_rate_mm_per_min (Z), junction_deviation_mm; " +
  "Grbl: $120 / $122, $112, $11. The simulator uses them to move at the speed the machine " +
  "really reaches — slower on short moves and into corners — so its clock, its chip-load " +
  "gauge and every run-time estimate match the real job. Set an acceleration to 0 to ignore " +
  "acceleration and time every move at its programmed feed."

const ORIGIN_GRID: OriginPosition[][] = [
  ['top-left', 'top-center', 'top-right'],
  ['mid-left', 'center', 'mid-right'],
  ['bottom-left', 'bottom-center', 'bottom-right'],
]

function OriginSelector({
  value,
  onChange,
}: {
  value: OriginPosition
  onChange: (o: OriginPosition) => void
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="inline-grid grid-cols-3 gap-1 p-1.5 bg-gray-50 dark:bg-neutral-900 rounded border border-gray-400 dark:border-neutral-700 w-fit">
        {ORIGIN_GRID.map((row) =>
          row.map((pos) => {
            const active = value === pos
            return (
              <button
                key={pos}
                title={pos.replace(/-/g, ' ')}
                onClick={() => onChange(pos)}
                className={[
                  'w-8 h-8 rounded flex items-center justify-center transition-colors border',
                  active
                    ? 'bg-blue-600 border-blue-400'
                    : 'bg-gray-100 dark:bg-neutral-800 border-gray-400 dark:border-neutral-600 hover:bg-gray-200 dark:hover:bg-neutral-700',
                ].join(' ')}
              >
                <div
                  className={[
                    'w-2 h-2 rounded-full',
                    active ? 'bg-white' : 'bg-gray-300 dark:bg-neutral-600',
                  ].join(' ')}
                />
              </button>
            )
          })
        )}
      </div>
      <p className="text-body text-gray-600 dark:text-neutral-400 capitalize">
        {value.replace(/-/g, ' ')}
      </p>
    </div>
  )
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-gray-300 dark:border-neutral-700">
      <button
        className="w-full flex items-center gap-1.5 px-3 py-2 text-body font-semibold text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 uppercase tracking-wider transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={ICON.xs} /> : <ChevronRight size={ICON.xs} />}
        {title}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

// Grouped wood → plastic → metal (the kind decides how thin a chip the material
// tolerates), then ordered softest → hardest within each group.
const KIND_ORDER: MaterialKind[] = ['wood', 'plastic', 'metal']
const KIND_LABELS: Record<MaterialKind, string> = { wood: 'Wood', plastic: 'Plastic', metal: 'Metal' }
const MATERIAL_GROUPS = KIND_ORDER.map((kind) => ({
  kind,
  materials: (Object.keys(MATERIAL_INFO) as Material[])
    .filter((m) => MATERIAL_INFO[m].kind === kind)
    .sort((a, b) => MATERIAL_INFO[a].hardness - MATERIAL_INFO[b].hardness),
}))

const RIGIDITY_LABELS: Record<number, string> = {
  1: 'Hobby (light gantry)',
  2: 'Light hobby',
  3: 'Prosumer',
  4: 'Heavy / industrial',
  5: 'Commercial CNC',
}

const AUTO_FEED_HELP =
  "When on, cutting feed and step-down are computed from material, tool and rigidity. " +
  "If the machine can't feed fast enough for the target chip load, the spindle speed is " +
  "lowered instead (a warning is added to the G-code — set it by hand if your machine has " +
  "no spindle control). When off, the tool's own feeds and your step-down are used."

const RIGIDITY_HELP =
  "How stiff your machine is. Higher rigidity allows faster feeds and deeper step-downs; " +
  "lower values back them off so a flexy gantry doesn't chatter or deflect. Pick the level " +
  "that matches your frame — it scales the auto feeds & speeds."

const SPINDLE_HELP =
  "Auto mode picks a spindle speed in this range — as fast as needed to reach the max feed " +
  "(shorter jobs). Set the min to your spindle's real floor (routers ≈10000) and lower the " +
  "max if a material burns at high speed."


export default function WorkpiecePanel() {
  const {
    widthMM, heightMM, thicknessMM, units, origin, zOrigin, material,
    tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM, safeHeightMM,
    machineRigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, spindleType, autoFeedEnabled,
    accelXYMmS2, accelZMmS2, maxRateZMmMin, junctionDeviationMM,
    setAccelXY, setAccelZ, setMaxRateZ, setJunctionDeviation,
    setWidth, setHeight, setThickness, setOrigin, setZOrigin, setMaterial,
    setTableLimitWidth, setTableLimitHeight, setTableLimitDepth, setSafeHeight,
    setMachineRigidity, setMaxFeed, setMinSpindleRpm, setMaxSpindleRpm, setSpindleType, setAutoFeedEnabled,
  } = useWorkpieceStore()
  const feedId = useId()

  return (
    <div className="flex flex-col">
      <Section title="Stock Dimensions">
        <DimInput label="Width (X)" valueMM={widthMM} units={units} onChange={setWidth} />
        <DimInput label="Height (Y)" valueMM={heightMM} units={units} onChange={setHeight} />
        <DimInput label="Thickness (Z)" valueMM={thicknessMM} units={units} onChange={setThickness} />
      </Section>

      <Section title="Work Origin">
        <p className="text-body text-gray-600 dark:text-neutral-400 mb-2">
          Select the X=0, Y=0 reference point on the stock.
          {zOrigin === 'bottom'
            ? ' Z=0 is the bottom of the stock (top surface is at +thickness).'
            : ' Z=0 is the top surface of the stock (cuts go negative).'}
        </p>
        <OriginSelector value={origin} onChange={setOrigin} />
        <div className="mt-3">
          <div className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Z Origin</div>
          <div className="inline-grid grid-cols-2 gap-1 w-full">
            {([['top', 'Top of stock'], ['bottom', 'Bottom of stock']] as const).map(([val, label]) => {
              const active = zOrigin === val
              return (
                <button
                  key={val}
                  onClick={() => setZOrigin(val)}
                  className={[
                    'px-2 py-1.5 rounded text-body transition-colors border',
                    active
                      ? 'bg-blue-600 border-blue-400 text-white'
                      : 'bg-gray-100 dark:bg-neutral-800 border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700',
                  ].join(' ')}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      </Section>

      <Section title="Material">
        <select
          value={material}
          onChange={(e) => setMaterial(e.target.value as Material)}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-600 rounded px-2 py-1.5 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none"
        >
          {MATERIAL_GROUPS.map((g) => (
            <optgroup key={g.kind} label={KIND_LABELS[g.kind]}>
              {g.materials.map((m) => (
                <option key={m} value={m}>
                  {MATERIAL_INFO[m].label} (hardness {MATERIAL_INFO[m].hardness.toFixed(1)})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="text-body text-gray-600 dark:text-neutral-400 mt-1.5">
          {KIND_LABELS[MATERIAL_INFO[material].kind]} · hardness {MATERIAL_INFO[material].hardness.toFixed(1)}
          <span className="text-gray-600 dark:text-neutral-400"> (used for auto feeds &amp; speeds)</span>
        </p>
      </Section>

      <Section title="Feeds &amp; Speeds">
        <div className="flex items-center gap-2 mb-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoFeedEnabled}
              onChange={(e) => setAutoFeedEnabled(e.target.checked)}
              className="accent-blue-500"
            />
            <span className="text-body text-gray-700 dark:text-neutral-300">
              Auto Feeds &amp; Speeds
            </span>
          </label>
          <InfoPopover text={AUTO_FEED_HELP} />
          {(() => {
            const rig = rigidityInfo(machineRigidity)
            return (
              <span className="ml-auto" title={`Rigidity ${machineRigidity} · ${RIGIDITY_LABELS[machineRigidity]}`}>
                <rig.Icon size={40} className={rig.color} />
              </span>
            )
          })()}
        </div>

        <div className="mb-3">
          <div className="flex items-center gap-2 mb-1">
            <label htmlFor="stock-rigidity" className="text-gray-500 dark:text-neutral-400 text-body">Machine Rigidity</label>
            <InfoPopover text={RIGIDITY_HELP} />
          </div>
          <select
            id="stock-rigidity"
            value={machineRigidity}
            onChange={(e) => setMachineRigidity(parseInt(e.target.value))}
            className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-600 rounded px-2 py-1.5 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none"
          >
            {[1, 2, 3, 4, 5].map((r) => (
              <option key={r} value={r}>
                {r} · {RIGIDITY_LABELS[r]}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-3 mb-1">
          <label htmlFor="stock-spindle" className="block text-gray-500 dark:text-neutral-400 text-body mb-1">Spindle / Router</label>
          <select
            id="stock-spindle"
            value={spindleType}
            onChange={(e) => setSpindleType(e.target.value as SpindleType)}
            className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-600 rounded px-2 py-1.5 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none"
          >
            {(Object.keys(SPINDLE_INFO) as SpindleType[]).map((t) => (
              <option key={t} value={t}>{SPINDLE_INFO[t].label}</option>
            ))}
          </select>
          {SPINDLE_INFO[spindleType].dial && (
            <p className="text-body text-gray-600 dark:text-neutral-400 mt-1">
              Spindle speeds also show the equivalent dial setting (1–6) in the tool table and simulation.
            </p>
          )}
        </div>

        {([
          ['Min Spindle', minSpindleRpm, setMinSpindleRpm] as const,
          ['Max Spindle', maxSpindleRpm, setMaxSpindleRpm] as const,
        ]).map(([label, value, onChange]) => (
          <div key={label} className="flex items-center gap-2 mt-3">
            <label htmlFor={`${feedId}-${label}`} className="text-gray-500 dark:text-neutral-400 text-body w-24 shrink-0">{label}</label>
            <NumericInput
              id={`${feedId}-${label}`}
              value={value}
              min={1000}
              step={1000}
              unit="RPM"
              onChange={onChange}
              className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-600 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none font-mono"
            />
            <InfoPopover text={SPINDLE_HELP} />
          </div>
        ))}
      </Section>

      <Section title="Machine Limits">
        <p className="text-body text-gray-600 dark:text-neutral-400 mb-2">
          Maximum travel for pre-export validation.
        </p>
        <DimInput
          label="Table Width"
          valueMM={tableLimitWidthMM}
          units={units}
          onChange={setTableLimitWidth}
        />
        <DimInput
          label="Table Height"
          valueMM={tableLimitHeightMM}
          units={units}
          onChange={setTableLimitHeight}
        />
        <DimInput
          label="Max Z Travel"
          valueMM={tableLimitDepthMM}
          units={units}
          onChange={setTableLimitDepth}
        />
        <DimInput
          label="Safe Height"
          valueMM={safeHeightMM}
          units={units}
          onChange={setSafeHeight}
          min={0.1}
        />
      </Section>

      <Section title="Machine Motion">
        <div className="flex items-center gap-2 mb-2">
          <p className="text-body text-gray-600 dark:text-neutral-400">
            From your controller's config — how fast it really moves.
          </p>
          <InfoPopover text={MOTION_HELP} />
        </div>
        <MotionInput label="Max Feed Rate" valueMM={maxFeedMmMin} units={units} unit={`${units}/min`}
          stepMM={50} stepIn={1} onChange={setMaxFeed} />
        <MotionInput label="Accel X/Y" valueMM={accelXYMmS2} units={units} unit={`${units}/s²`}
          stepMM={10} stepIn={0.5} onChange={setAccelXY} />
        <MotionInput label="Accel Z" valueMM={accelZMmS2} units={units} unit={`${units}/s²`}
          stepMM={5} stepIn={0.25} onChange={setAccelZ} />
        <MotionInput label="Z Max Rate" valueMM={maxRateZMmMin} units={units} unit={`${units}/min`}
          stepMM={50} stepIn={2} onChange={setMaxRateZ} />
        <MotionInput label="Junction Dev." valueMM={junctionDeviationMM} units={units} unit={units}
          stepMM={0.005} stepIn={0.0002} onChange={setJunctionDeviation} />
        <p className="text-body text-gray-600 dark:text-neutral-400 mt-1">
          Max Feed Rate is the X/Y max rate: a hard ceiling generated feeds never exceed, even
          with auto feeds off, and the speed rapids run at.
        </p>
      </Section>
    </div>
  )
}
