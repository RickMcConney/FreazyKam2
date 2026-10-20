// Spindle / router speed reference. Many hobby CNCs run a fixed-speed-dial trim
// router rather than a continuously-variable VFD spindle, so the G-code RPM has to
// be translated to the physical dial setting (1–6) the operator actually turns.
//
// Dial→RPM figures are the manufacturers' published speed charts:
//   • DeWalt DWP611 / DW611 compact router (the "DW6xx" series).
//   • Makita RT0701C (a.k.a. RT07 / 3709 trim router).
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
      { setting: 1, rpm: 16000 },
      { setting: 2, rpm: 18200 },
      { setting: 3, rpm: 21400 },
      { setting: 4, rpm: 24800 },
      { setting: 5, rpm: 27600 },
      { setting: 6, rpm: 30000 },
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

// Interpolated dial setting for a target RPM (e.g. 19800 → 2.5 on the DeWalt). RPM
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
