// Shared grid / ruler utilities — both use the same step so lines always
// align with ruler ticks.

const MM_STEPS    = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]
const IN_STEPS_MM = [
  25.4 / 8,   // 1/8"
  25.4 / 4,   // 1/4"
  25.4 / 2,   // 1/2"
  25.4,       // 1"
  25.4 * 2,   // 2"
  25.4 * 5,   // 5"
  25.4 * 10,  // 10"
  25.4 * 25,  // 25"
]
const TARGET_PX = 80

/** Pick the step (in mm) that puts major ticks closest to TARGET_PX apart. */
export function majorStepMM(scale: number, units: 'mm' | 'in'): number {
  const steps = units === 'in' ? IN_STEPS_MM : MM_STEPS
  return steps.reduce((best, s) =>
    Math.abs(s * scale - TARGET_PX) < Math.abs(best * scale - TARGET_PX) ? s : best
  )
}

/**
 * Minor step that subdivides the major step.
 * MM: ÷5 (4 visible minor lines per major interval).
 * Inches: ÷4 (3 visible minor lines per major interval).
 */
export function minorStepMM(major: number, units: 'mm' | 'in'): number {
  return units === 'in' ? major / 4 : major / 5
}

// ── Inch label formatting ─────────────────────────────────────────────────

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

// Unicode fractions for the values that have dedicated characters
const FRAC_CHARS: Record<string, string> = {
  '1/2': '½',
  '1/4': '¼', '3/4': '¾',
  '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞',
}

function formatInch(mm: number, unicodeFractions: boolean): string {
  // Round to nearest 1/32"
  const n32 = Math.round((mm / 25.4) * 32)
  if (n32 === 0) return '0'
  const neg  = n32 < 0
  const abs  = Math.abs(n32)
  const whole = Math.floor(abs / 32)
  const rem   = abs % 32
  const sign  = neg ? '-' : ''
  if (rem === 0) return `${sign}${whole}`
  const g    = gcd(rem, 32)
  const num  = rem / g
  const den  = 32 / g
  const plain = `${num}/${den}`
  const frac = unicodeFractions ? FRAC_CHARS[plain] ?? plain : plain
  if (whole === 0) return `${sign}${frac}`
  // A glyph sits tight against the whole number (2¾); typed-out text needs a space
  // or "23/4" reads as twenty-three quarters.
  return unicodeFractions && FRAC_CHARS[plain]
    ? `${sign}${whole}${frac}`
    : `${sign}${whole} ${frac}`
}

/**
 * Format a CNC-relative mm value as a ruler label in the given display unit.
 *
 * `unicodeFractions` picks ½/¼/⅛ glyphs where one exists. Only the tick labels
 * want that: sixteenths and thirty-seconds have no glyph, so a run of values
 * comes out half typeset and half typed ("⅛, 3/16, ¼"). Anywhere a single value
 * has to read the same at every zoom, pass false and get plain text throughout.
 */
export function formatRulerLabel(
  mm: number,
  units: 'mm' | 'in',
  unicodeFractions = true,
): string {
  if (units === 'in') return formatInch(mm, unicodeFractions)
  if (Math.abs(mm) < 0.001) return '0'
  // Use the fewest decimal places that round-trip the value (avoids "10.5" → "11").
  for (const d of [0, 1, 2, 3] as const) {
    if (Math.abs(parseFloat(mm.toFixed(d)) - mm) < 1e-9) return mm.toFixed(d)
  }
  return mm.toFixed(3)
}
