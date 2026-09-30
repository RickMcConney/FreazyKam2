import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MotionLimits } from '../sim/motionPlanner'
import { useTimelineStore } from '../timeline/timelineStore'
import type { WorkpieceEventChanges } from '../timeline/events'
import type { SpindleType } from './spindle'

export type Units = 'mm' | 'in'

export type OriginPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'mid-left' | 'center' | 'mid-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right'

// Where Z=0 sits on the stock. 'top' (default) = Z=0 at the top surface, cuts go
// negative. 'bottom' = Z=0 at the stock bottom, so the top surface is at +thickness.
// Internally all toolpath Z stays top-referenced; this only shifts the emitted G-code
// (and the 3D datum readout) by the stock thickness. See zDatumOffsetMM.
export type ZOrigin = 'top' | 'bottom'

// Machine-Z offset to add to top-referenced segment Z to express it in the chosen Z
// datum: 0 for top-of-stock, +thickness for bottom-of-stock. The Z analog of
// originWorldXY (src/canvas/layers/WorkpieceLayer.tsx) for the XY origin.
export function zDatumOffsetMM(zOrigin: ZOrigin, thicknessMM: number): number {
  return zOrigin === 'bottom' ? thicknessMM : 0
}

export type Material =
  | 'pine' | 'cedar' | 'oak' | 'maple' | 'walnut' | 'cherry'
  | 'mdf' | 'plywood' | 'hdpe' | 'delrin' | 'acrylic' | 'aluminum' | 'brass' | 'other'

// What a material does with heat and a thin chip — the one thing a single hardness
// number could not say. A wood tolerates a light chip (it burns, slowly); a plastic
// does not: below its chip load the edge rubs, the heat has nowhere to go but the
// cut, and the plastic melts and welds back into the slot. A metal sits between.
export type MaterialKind = 'wood' | 'plastic' | 'metal'

export interface MaterialInfo {
  label: string
  kind: MaterialKind
  hardness: number
  chipLoadMM: number
  maxSurfaceSpeedMMin?: number
}

// Single source of truth for the materials list and the numbers auto feeds &
// speeds derive from (cam/feeds.ts). Used by the WorkpiecePanel dropdown too.
//
// chipLoadMM: the recommended chip load (mm per tooth) for a 6 mm carbide end mill
// — the figure a manufacturer's chip-load chart gives, before the machine enters.
// The feed calculation scales it by tool type and diameter, and trims it for a
// light machine only as far as the material allows (see MIN_CHIP_FRACTION in
// feeds.ts: a plastic's chip is barely trimmed at all). Sources: Onsrud / Amana
// routing charts — softwood and MDF ≈ 0.006"/tooth on a 1/4" 2-flute, hardwood
// 0.004–0.005", HDPE 0.007–0.010", acetal (Delrin) 0.005–0.007" on a single-flute
// O-flute, acrylic 0.004–0.006", aluminium dry on a hobby machine 0.001–0.003",
// leaded brass a little less.
//
// hardness: relative machining hardness (mdf ≈ 0.8 baseline). It no longer sets the
// chip — only the step-down (harder = shallower passes) and the dropdown order.
// Wood values track Janka hardness ratings (lbf) from The Wood Database
// (https://www.wood-database.com), scaled so MDF ≈ 0.8: cedar (W. red) ~350, pine
// (E. white) ~380, cherry ~950, walnut ~1010, maple (hard) ~1450, oak (red) ~1290.
// Metals are scaled by relative cutting resistance, not Janka. Delrin machines
// cleanly and dry, level with plywood; acrylic is brittle and chips or crazes
// under a deep pass, so it sits a step above.
//
// maxSurfaceSpeedMMin (optional): a cutting-speed (Vc) ceiling in m/min, used to
// cap spindle RPM so the edge doesn't overheat. Woods omit it. Values are
// conservative dry-cutting limits for carbide on a hobby machine (no flood
// coolant): aluminum tolerates higher Vc thanks to its high thermal conductivity;
// free-machining brass runs hotter at the edge (lower conductivity, higher cutting
// force) so it gets a lower ceiling. Delrin softens around 175 °C, so it is capped
// at the top of its published carbide range (500–1500 SFM ≈ 150–450 m/min). That
// only bites on bits of about 6 mm and up at full router speed. Acrylic softens
// sooner still (glass transition ~105 °C) and its routing settings top out around
// 18,000 rpm on a 1/4" bit, so it is capped at 360 m/min. A Vc ceiling does NOT
// stop a plastic melting on its own — a thin chip at any rpm does that — which is
// why the chip load above is the number that matters for them.
export const MATERIAL_INFO: Record<Material, MaterialInfo> = {
  pine: { label: 'Pine', kind: 'wood', hardness: 0.6, chipLoadMM: 0.15 },
  cedar: { label: 'Cedar', kind: 'wood', hardness: 0.5, chipLoadMM: 0.15 },
  oak: { label: 'Oak', kind: 'wood', hardness: 1.4, chipLoadMM: 0.10 },
  maple: { label: 'Maple', kind: 'wood', hardness: 1.3, chipLoadMM: 0.10 },
  walnut: { label: 'Walnut', kind: 'wood', hardness: 1.1, chipLoadMM: 0.11 },
  cherry: { label: 'Cherry', kind: 'wood', hardness: 1.2, chipLoadMM: 0.11 },
  mdf: { label: 'MDF', kind: 'wood', hardness: 0.8, chipLoadMM: 0.15 },
  plywood: { label: 'Plywood', kind: 'wood', hardness: 0.9, chipLoadMM: 0.12 },
  hdpe: { label: 'HDPE', kind: 'plastic', hardness: 0.7, chipLoadMM: 0.20 },
  delrin: { label: 'Delrin', kind: 'plastic', hardness: 0.9, chipLoadMM: 0.16, maxSurfaceSpeedMMin: 450 }, // acetal/POM; carbide 150–450 m/min
  acrylic: { label: 'Acrylic', kind: 'plastic', hardness: 1.0, chipLoadMM: 0.12, maxSurfaceSpeedMMin: 360 }, // PMMA; ≈18k rpm on a 1/4" bit
  aluminum: { label: 'Aluminum', kind: 'metal', hardness: 2.5, chipLoadMM: 0.05, maxSurfaceSpeedMMin: 150 }, // dry carbide range 150–250
  brass: { label: 'Brass', kind: 'metal', hardness: 2.8, chipLoadMM: 0.04, maxSurfaceSpeedMMin: 100 }, // leaded C360; dry carbide range 100–150
  other: { label: 'Other', kind: 'wood', hardness: 1.0, chipLoadMM: 0.10 },
}

export const MM_PER_INCH = 25.4

export const toMM = (value: number, units: Units): number =>
  units === 'in' ? value * MM_PER_INCH : value

export const fromMM = (value: number, units: Units): number =>
  units === 'in' ? +(value / MM_PER_INCH).toFixed(4) : +value.toFixed(3)

// `fromMM`/`toMM` move the number; these format it WITH its unit. Every length a form
// prints read-only — a resolved start Z, a groove width, a tool diameter in a dropdown —
// goes through `fmtLen`, so a figure the user can only read is written the same way as
// one they can type into.
// The number alone, at the right precision for its unit — for a field that puts its unit
// in a separate element (every editable one does, so a read-only twin beside it must too).
export const lenValue = (mm: number, units: Units, mmDigits = 2): string =>
  units === 'in' ? (mm / MM_PER_INCH).toFixed(3) : mm.toFixed(mmDigits)

export const fmtLen = (mm: number, units: Units, mmDigits = 2): string =>
  units === 'in' ? `${lenValue(mm, units)}"` : `${lenValue(mm, units, mmDigits)} mm`

export const fmtFeed = (mmPerMin: number, units: Units): string =>
  units === 'in' ? `${(mmPerMin / MM_PER_INCH).toFixed(1)} in/min` : `${Math.round(mmPerMin)} mm/min`

// Arrow-key step for a length field in inch mode. A converted mm step is an unusable
// number to nudge by (0.5 mm = 0.0197"), so snap to the nearest 1-2-5 inch step instead —
// the field still holds any value the user types, this only sizes the arrow keys.
const INCH_STEPS = [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25]
export const inchStepFor = (stepMM: number): number => {
  const target = stepMM / MM_PER_INCH
  return INCH_STEPS.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best))
}

interface WorkpieceState {
  widthMM: number
  heightMM: number
  thicknessMM: number
  units: Units
  origin: OriginPosition
  zOrigin: ZOrigin
  material: Material
  tableLimitWidthMM: number
  tableLimitHeightMM: number
  tableLimitDepthMM: number
  safeHeightMM: number
  machineRigidity: number      // 1 (hobby) … 5 (commercial CNC)
  maxFeedMmMin: number         // hard ceiling the machine can sustain — never exceeded
  minSpindleRpm: number        // machine's lowest usable spindle speed (clamp floor)
  maxSpindleRpm: number        // machine's top spindle speed — auto may raise rpm up to this
  // How the machine's own planner moves (copy from the controller's config — FluidNC
  // `acceleration_mm_per_sec2`, `max_rate_mm_per_min`, `junction_deviation_mm`; Grbl
  // $120–$122, $112, $11). The simulator, its chip-load gauge and every run-time estimate
  // use them to find the speed the machine REALLY reaches (sim/motionPlanner.ts). An
  // acceleration of 0 turns that off: every move then runs at its programmed feed.
  accelXYMmS2: number
  accelZMmS2: number
  maxRateZMmMin: number
  junctionDeviationMM: number
  spindleType: SpindleType     // router/spindle model — drives the RPM→dial readout
  autoFeedEnabled: boolean     // when true, feeds/step-down are computed (cam/feeds.ts)
  setWidth: (mm: number) => void
  setHeight: (mm: number) => void
  setThickness: (mm: number) => void
  setUnits: (u: Units) => void
  setOrigin: (o: OriginPosition) => void
  setZOrigin: (o: ZOrigin) => void
  setMaterial: (m: Material) => void
  setTableLimitWidth: (mm: number) => void
  setTableLimitHeight: (mm: number) => void
  setTableLimitDepth: (mm: number) => void
  setSafeHeight: (mm: number) => void
  setMachineRigidity: (r: number) => void
  setMaxFeed: (mm: number) => void
  setMinSpindleRpm: (rpm: number) => void
  setMaxSpindleRpm: (rpm: number) => void
  setSpindleType: (t: SpindleType) => void
  setAccelXY: (mmS2: number) => void
  setAccelZ: (mmS2: number) => void
  setMaxRateZ: (mmMin: number) => void
  setJunctionDeviation: (mm: number) => void
  setAutoFeedEnabled: (v: boolean) => void
}

export const useWorkpieceStore = create<WorkpieceState>()(
  persist(
    (set, get) => {
      // Project-scoped setters record a workpiece.set timeline event (skipped
      // when the value is unchanged, so form re-commits don't spam the log).
      // Machine-local setters below (table limits, rigidity, feeds, spindle,
      // safe height) stay OFF the timeline — they're machine config, not
      // project history. Scrub restores bypass these via setState directly.
      const setProj = <K extends keyof WorkpieceEventChanges>(key: K, value: Required<WorkpieceEventChanges>[K]) => {
        if (get()[key] === value) return
        set({ [key]: value } as Partial<WorkpieceState>)
        useTimelineStore.getState().record({ kind: 'workpiece.set', changes: { [key]: value } })
      }
      return ({
      widthMM: 300,
      heightMM: 200,
      thicknessMM: 18,
      units: 'mm',
      origin: 'bottom-left',
      zOrigin: 'top',
      material: 'mdf',
      tableLimitWidthMM: 800,
      tableLimitHeightMM: 600,
      tableLimitDepthMM: 70,
      safeHeightMM: 5,
      machineRigidity: 3,
      maxFeedMmMin: 3000,
      minSpindleRpm: 8000,
      maxSpindleRpm: 24000,
      spindleType: 'vfd',
      // Typical of a hobby machine on Grbl/FluidNC; the user's own config replaces them.
      accelXYMmS2: 200,
      accelZMmS2: 50,
      maxRateZMmMin: 600,
      junctionDeviationMM: 0.01,
      autoFeedEnabled: false,
      setWidth: (mm) => setProj('widthMM', mm),
      setHeight: (mm) => setProj('heightMM', mm),
      setThickness: (mm) => setProj('thicknessMM', mm),
      setUnits: (u) => setProj('units', u),
      setOrigin: (o) => setProj('origin', o),
      setZOrigin: (o) => setProj('zOrigin', o),
      setMaterial: (m) => setProj('material', m),
      setTableLimitWidth: (mm) => set({ tableLimitWidthMM: mm }),
      setTableLimitHeight: (mm) => set({ tableLimitHeightMM: mm }),
      setTableLimitDepth: (mm) => set({ tableLimitDepthMM: mm }),
      setSafeHeight: (mm) => set({ safeHeightMM: mm }),
      setMachineRigidity: (r) => set({ machineRigidity: Math.max(1, Math.min(5, Math.round(r))) }),
      setMaxFeed: (mm) => set({ maxFeedMmMin: mm }),
      setMinSpindleRpm: (rpm) => set({ minSpindleRpm: rpm }),
      setMaxSpindleRpm: (rpm) => set({ maxSpindleRpm: rpm }),
      setSpindleType: (t) => set({ spindleType: t }),
      setAccelXY: (v) => set({ accelXYMmS2: Math.max(0, v) }),
      setAccelZ: (v) => set({ accelZMmS2: Math.max(0, v) }),
      setMaxRateZ: (v) => set({ maxRateZMmMin: Math.max(0, v) }),
      setJunctionDeviation: (v) => set({ junctionDeviationMM: Math.max(0, v) }),
      setAutoFeedEnabled: (v) => set({ autoFeedEnabled: v }),
      })
    },
    { name: 'freazykam-workpiece' }
  )
)

/** The machine's motion limits as the planner (sim/motionPlanner.ts) takes them. */
export function machineMotionLimits(): MotionLimits {
  const s = useWorkpieceStore.getState()
  return {
    accelXYMmS2: s.accelXYMmS2,
    accelZMmS2: s.accelZMmS2,
    maxRateXYMmMin: s.maxFeedMmMin,
    maxRateZMmMin: s.maxRateZMmMin,
    junctionDeviationMM: s.junctionDeviationMM,
  }
}
