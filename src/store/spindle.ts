// Spindle / router speed reference. Many hobby CNCs run a fixed-speed-dial trim
// router rather than a continuously-variable VFD spindle, so the G-code RPM has to
// be translated to the physical dial setting (1–6) the operator actually turns.
//
// Dial→RPM figures are the manufacturers' published speed charts:
//   • DeWalt DWP611 / DW611 compact router (the "DW6xx" series).
//   • Makita RT0701C (a.k.a. RT07 / 3709 trim router).
// VFD and manual spindles are continuously variable, so they carry no dial table —
// the raw RPM is the whole story for them.

export type SpindleType = 'vfd' | 'manual' | 'dewalt-compact' | 'makita-rt07'

interface DialPoint { setting: number; rpm: number }

export interface SpindleInfo {
  label: string
  /** Dial detent → RPM, ascending by RPM. Absent for continuously-variable spindles. */
  dial?: DialPoint[]
}

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
}

// Interpolated dial setting for a target RPM (e.g. 19800 → 2.5 on the DeWalt). RPM
// below the slowest / above the fastest detent clamps to the end setting. Returns
// null for spindles without a dial table or a non-positive RPM.
function spindleDial(type: SpindleType, rpm: number): number | null {
  const d = SPINDLE_INFO[type].dial
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
export function spindleDialLabel(type: SpindleType, rpm: number): string | null {
  const dial = spindleDial(type, rpm)
  if (dial == null) return null
  const rounded = Math.round(dial * 2) / 2
  return `dial ${rounded}`
}
