// Spindle / router speed reference. Many hobby CNCs run a fixed-speed-dial trim
// router rather than a continuously-variable VFD spindle, so the G-code RPM has to
// be translated to the physical dial setting (1–6) the operator actually turns.
//
// Dial→RPM figures are the routers' speed charts:
//   • DeWalt DWP611 / DW611 compact router (the "DW6xx" series) — DeWalt rates it
//     16,000–27,000 rpm. The table used to run on to 30,000 (a Makita's top speed), so
//     dial 4–6 read 12–18% fast: auto feeds planned speeds the router never reached and
//     every chip came out that much thicker than it meant.
//   • Makita RT0701C (a.k.a. RT07 / 3709 trim router) — 10,000–30,000 rpm, within ~4%
//     of a tachometer at every detent.
// VFD and manual spindles are continuously variable, so they carry no dial table —
// the raw RPM is the whole story for them. Any other router is 'custom': the user types
// the six speeds from its manual (`customDialRpm` in the workpiece store), so a new
// router never needs a release.

export type SpindleType = 'vfd' | 'manual' | 'dewalt-compact' | 'makita-rt07' | 'custom'

interface DialPoint { setting: number; rpm: number }

export interface SpindleInfo {
  label: string
  /** Dial detent → RPM, ascending by RPM. Absent for continuously-variable spindles. */
  dial?: DialPoint[]
  /** The dial table is the user's own (`customDialRpm`), not a published chart. */
  custom?: boolean
}

/** Detents on a custom router's dial — 1 to 6, as on every router charted here. */
export const CUSTOM_DIAL_SETTINGS = 6
/** A custom router's speeds before the user enters their own — a generic 10k–30k compact router. */
export const DEFAULT_CUSTOM_DIAL_RPM = [10000, 14000, 18000, 22000, 26000, 30000]

export const SPINDLE_INFO: Record<SpindleType, SpindleInfo> = {
  vfd: { label: 'VFD spindle (variable)' },
  manual: { label: 'Manual / fixed speed' },
  'dewalt-compact': {
    label: 'DeWalt DW6xx (DWP611)',
    dial: [
      { setting: 1, rpm: 16200 },
      { setting: 2, rpm: 17700 },
      { setting: 3, rpm: 19450 },
      { setting: 4, rpm: 21100 },
      { setting: 5, rpm: 23500 },
      { setting: 6, rpm: 26900 },
    ],
  },
  'makita-rt07': {
    label: 'Makita RT07 (RT0701C)',
    dial: [
      { setting: 1, rpm: 10000 },
      { setting: 2, rpm: 12000 },
      { setting: 3, rpm: 17000 },
      { setting: 4, rpm: 22000 },
      { setting: 5, rpm: 27000 },
      { setting: 6, rpm: 30000 },
    ],
  },
  custom: { label: 'Custom router (own dial chart)', custom: true },
}

/** Whether this spindle's speed is set on a numbered dial (a custom router always is). */
export function spindleHasDial(type: SpindleType): boolean {
  const info = SPINDLE_INFO[type]
  return !!(info.dial || info.custom)
}

/** Whether a custom dial is usable: one finite, positive speed per detent, rising with the dial. */
export function customDialValid(rpm: readonly number[]): boolean {
  return rpm.length === CUSTOM_DIAL_SETTINGS
    && rpm.every((r) => Number.isFinite(r) && r > 0)
    && rpm.every((r, i) => i === 0 || r > rpm[i - 1])
}

/** A stored custom dial as the store keeps it: six finite numbers, else the default. */
export function normalizeCustomDial(v: unknown): number[] {
  return Array.isArray(v) && v.length === CUSTOM_DIAL_SETTINGS && v.every((r) => typeof r === 'number' && Number.isFinite(r))
    ? [...v]
    : [...DEFAULT_CUSTOM_DIAL_RPM]
}

/** The dial table in force, or null when there is none — a VFD, or a custom dial whose
 *  speeds do not rise with the setting (interpolating one would give a wrong dial). */
export function spindleDialTable(type: SpindleType, customDialRpm?: readonly number[]): DialPoint[] | null {
  const info = SPINDLE_INFO[type]
  if (info.dial) return info.dial
  if (!info.custom || !customDialRpm || !customDialValid(customDialRpm)) return null
  return customDialRpm.map((rpm, i) => ({ setting: i + 1, rpm }))
}

/** The rpm range a dial router can actually run — its slowest and fastest detents. */
export function spindleDialRange(type: SpindleType, customDialRpm?: readonly number[]): { min: number; max: number } | null {
  const d = spindleDialTable(type, customDialRpm)
  return d ? { min: d[0].rpm, max: d[d.length - 1].rpm } : null
}

/** A stored spindle range held inside a CHARTED router's dial range. The range is set
 *  only when the router is chosen, so a setup saved against an old chart kept its old
 *  top speed; this is applied on load. A range the user narrowed stays narrowed. A custom
 *  router's chart is the user's own and is left alone, as is a VFD's. */
export function clampToChartedRange(type: SpindleType, minRpm: number, maxRpm: number): { minSpindleRpm: number; maxSpindleRpm: number } {
  const d = SPINDLE_INFO[type]?.dial
  if (!d) return { minSpindleRpm: minRpm, maxSpindleRpm: maxRpm }
  const lo = d[0].rpm, hi = d[d.length - 1].rpm
  const max = Math.min(Math.max(maxRpm, lo), hi)
  return { minSpindleRpm: Math.min(Math.max(minRpm, lo), max), maxSpindleRpm: max }
}

// Interpolated dial setting for a target RPM (e.g. 18600 → 2.5 on the DeWalt). RPM
// below the slowest / above the fastest detent clamps to the end setting. Returns
// null for spindles without a dial table or a non-positive RPM.
function spindleDial(type: SpindleType, rpm: number, customDialRpm?: readonly number[]): number | null {
  const d = spindleDialTable(type, customDialRpm)
  if (!d || rpm <= 0) return null
  if (rpm <= d[0].rpm) return d[0].setting
  if (rpm >= d[d.length - 1].rpm) return d[d.length - 1].setting
  for (let i = 0; i < d.length - 1; i++) {
    const a = d[i], b = d[i + 1]
    if (rpm >= a.rpm && rpm <= b.rpm) {
      const t = (rpm - a.rpm) / (b.rpm - a.rpm)
      return a.setting + t * (b.setting - a.setting)
    }
  }
  return null
}

// Short label for the dial setting, rounded to the nearest half-detent that a router
// dial can actually be set to (e.g. "dial 2.5"). Null when not applicable.
export function spindleDialLabel(type: SpindleType, rpm: number, customDialRpm?: readonly number[]): string | null {
  const setting = spindleDialSetting(type, rpm, customDialRpm)
  return setting == null ? null : `dial ${setting}`
}

/** The dial setting for `rpm`, to the half detent; null for a spindle without a dial. */
export function spindleDialSetting(type: SpindleType, rpm: number, customDialRpm?: readonly number[]): number | null {
  const dial = spindleDial(type, rpm, customDialRpm)
  return dial == null ? null : Math.round(dial * 2) / 2
}
