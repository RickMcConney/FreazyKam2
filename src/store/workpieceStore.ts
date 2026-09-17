import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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
  | 'mdf' | 'plywood' | 'hdpe' | 'aluminum' | 'brass' | 'other'

// Single source of truth for the materials list and their relative machining
// hardness (mdf ≈ 0.8 baseline). Higher = harder = gentler feeds/step-down.
// Used by the WorkpiecePanel dropdown and the feeds/speeds calculation (cam/feeds.ts).
//
// Hardness source: wood values track Janka hardness ratings (lbf) from The Wood
// Database (https://www.wood-database.com), scaled so MDF ≈ 0.8. For reference,
// the underlying Janka figures are roughly: cedar (W. red) ~350, pine (E. white)
// ~380, cherry ~950, walnut ~1010, maple (hard) ~1450, oak (red) ~1290. Metals
// (aluminum, brass) are scaled higher by relative cutting resistance, not Janka.
//
// maxSurfaceSpeedMMin (optional): a cutting-speed (Vc) ceiling in m/min, used to
// cap spindle RPM for metals so the edge doesn't overheat. Woods/plastics love
// max RPM and omit it. Values are conservative dry-cutting limits for carbide on
// a hobby machine (no flood coolant): aluminum tolerates higher Vc thanks to its
// high thermal conductivity; free-machining brass runs hotter at the edge (lower
// conductivity, higher cutting force) so it gets a lower ceiling.
export const MATERIAL_INFO: Record<Material, { label: string; hardness: number; maxSurfaceSpeedMMin?: number }> = {
  pine: { label: 'Pine', hardness: 0.6 },
  cedar: { label: 'Cedar', hardness: 0.5 },
  oak: { label: 'Oak', hardness: 1.4 },
  maple: { label: 'Maple', hardness: 1.3 },
  walnut: { label: 'Walnut', hardness: 1.1 },
  cherry: { label: 'Cherry', hardness: 1.2 },
  mdf: { label: 'MDF', hardness: 0.8 },
  plywood: { label: 'Plywood', hardness: 0.9 },
  hdpe: { label: 'HDPE', hardness: 0.7 },
  aluminum: { label: 'Aluminum', hardness: 2.5, maxSurfaceSpeedMMin: 150 }, // dry carbide range 150–250
  brass: { label: 'Brass', hardness: 2.8, maxSurfaceSpeedMMin: 100 }, // leaded C360; dry carbide range 100–150
  other: { label: 'Other', hardness: 1.0 },
}

const MM_PER_INCH = 25.4

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
      setAutoFeedEnabled: (v) => set({ autoFeedEnabled: v }),
      })
    },
    { name: 'freazykam-workpiece' }
  )
)
